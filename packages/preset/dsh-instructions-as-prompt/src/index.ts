/**
 * 把工作区 AGENTS.md 指令作为 **system-prompt section** 注入，**只注入一次**。
 *
 * ## 职责边界
 *
 * 本插件只做一件事：首次 assembly 时把 baseline 放进 system prompt，此后内容
 * **冻结**。变更提醒**不归本插件**——上游 `dsh-agent-instructions` 已完备地负责
 * 增量检测与 `<system-reminder>` 投递，重复实现只会引入不一致。
 *
 * ## 为什么冻结
 *
 * system prompt 是会话 surface 的 node 0，其内容变化会替换该节点并触发
 * `startsSeries`，使 provider 侧的 KV cache 失效。而 AGENTS.md 是会变的
 * （编辑、fs 工具触达嵌套目录）。所以 section 只在首次注入，之后不再重算：
 * 前缀缓存保持稳定，变更由上游走对话尾部的 reminder 通道告知模型。
 *
 * ## 与上游的关系
 *
 * 上游 `dsh-agent-instructions` 把 baseline 作为 user 消息注入；本插件复用它的
 * 文件发现、内容去重与字节预算（`loadBaselineInstructions`），只把 baseline 的
 * **落点**从 user 消息改成 system-prompt section。
 *
 * 两者**可同时挂载**：上游那份在 user 消息里承担增量更新，本插件这份在 system
 * prompt 里作为稳定前缀。同一份指令出现两次是刻意分工，不是重复注入。
 *
 * ## 为什么挂 `system-prompt/assemble`
 *
 * section 的 `text` provider 是同步的（`(context) => string`），而文件加载是
 * 异步的。`assemble` 是唯一的异步装配点，且其返回值权威。
 *
 * @module @morlay/dsh-instructions-as-prompt
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { loadBaselineInstructions } from "@deepseek-ai/dsh-agent-instructions";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import type {
  AssembleContext,
  PromptAssembly,
} from "@deepseek-ai/dsh-system-prompt";

export const name = "instructions-as-prompt";

/**
 * 依赖的 cordis 服务。
 *
 * 只需 `systemPrompt`——本插件挂在它的装配 waterfall 上。冻结值从 system
 * prompt 节点自身重建，不再依赖 `sessionProjections`（自定义事件类型会被
 * 持久化读路径拒绝，见 MARKER_BEGIN 的说明）。
 */
export const inject = ["systemPrompt"];

/** 本插件注入的 section 名（唯一）。 */
export const SECTION_NAME = "workspace:instructions";

/**
 * section 文本的包裹标记。
 *
 * 冻结值**不写自定义日志事件**——上游 `Session.append()` 不写 `ignorable`
 * 标记，而持久化读路径会拒绝未知事件类型（"unknown to this harness and not
 * marked ignorable"）。因此改为：把注入文本包在标记里，它随 system prompt 的
 * `system/message` 节点一起持久化，之后从该节点提取即可重建冻结值。
 *
 * 用注释风格而非 XML 标签：这段文本同时是模型可见内容，标记需低调且不易与
 * 指令正文冲突。
 */
export const MARKER_BEGIN = "<workspace-instructions>";
export const MARKER_END = "</workspace-instructions>";

/** 把 section 文本包进标记，使其可从 system prompt 中可靠提取。 */
export function wrapSectionText(text: string): string {
  return `${MARKER_BEGIN}\n${text}\n${MARKER_END}`;
}

/**
 * 从一段 system prompt 文本里提取本插件注入的指令正文。
 * @param prompt - 完整的 system prompt 文本。
 * @returns 标记内的正文；无标记时返回 undefined。
 */
export function extractSectionText(prompt: string): string | undefined {
  const start = prompt.indexOf(MARKER_BEGIN);
  if (start < 0) return undefined;
  const end = prompt.indexOf(MARKER_END, start);
  if (end < 0) return undefined;
  return prompt.slice(start + MARKER_BEGIN.length, end).trim();
}

/** 插件配置：沿用上游 agent-instructions 的发现与预算字段。 */
export interface Config {
  /** Harness home（含用户全局 `AGENTS.md`）；缺省用 `$DSH_HOME` 或 `~/.dsh`。 */
  dshHome?: string;
  /** 向上寻找项目根的目录标记。 */
  projectRootMarkers?: string[];
  /** 一次渲染的 UTF-8 字节上限；非正数禁用加载。 */
  maxBytes: number;
  /** 单文件读取上限。 */
  maxSourceBytes?: number;
  /** 同目录基础候选文件（按序）；缺省只认 `AGENTS.md`。 */
  instructionFileCandidates?: string[];
  /** 同目录 local overlay 候选文件（按序）；缺省只认 `AGENTS.local.md`。 */
  localInstructionFileCandidates?: string[];
}

/** 上游 `loadBaselineInstructions` 的选项类型（该类型未从包索引导出）。 */
type LoadOptions = Parameters<typeof loadBaselineInstructions>[0];

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([".git"]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1),
  instructionFileCandidates: z.array(z.string()).default(["AGENTS.md"]),
  localInstructionFileCandidates: z
    .array(z.string())
    .default(["AGENTS.local.md"]),
});

/** 一次 assembly 的会话事实。 */
interface AgentFacts {
  agent: Agent | undefined;
  cwd: string;
}

/**
 * 取出一次 assembly 对应的 agent 与工作目录。
 * @param context - 本次 assembly 的上下文。
 * @returns agent（若有）与绝对工作目录。
 */
function factsOf(context: AssembleContext): AgentFacts {
  const agent = (context as { agent?: Agent }).agent;
  const cwd = agent?.session.header.cwd ?? process.cwd();
  return { agent, cwd };
}

/**
 * 去掉上游渲染的 `<system-reminder>` 框架，保留正文。
 *
 * 上游把框架烘焙进内容（session surface 逐字投影、不再包裹），那是 user 消息的
 * 呈现约定；system prompt 里不需要这层信封。
 * @param text - 上游渲染结果。
 * @returns 去框架后的正文。
 */
export function unwrapReminder(text: string): string {
  const open = "<system-reminder>";
  const close = "</system-reminder>";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < 0 || end < start) return text;
  return text.slice(start + open.length, end).trim();
}

/**
 * 把工作区指令 section 插到部署 persona 之后、其余内容之前。
 *
 * 按**位置**而非数值插入：`assembly.sections` 已由装配器按 order 排好序，而上游
 * 只导出 persona 两个 section 名常量、`getSectionOrder()` 又需要 `SystemPrompt`
 * 实例（waterfall 里拿不到）。锚在 persona prefix 上既表达「项目指令比 persona
 * 具体、早于工具指引」，也不必复制 order 表跟着上游 drift。
 * @param sections - 已排序的 section 列表。
 * @param text - 工作区指令正文。
 * @returns 插入后的新列表。
 */
export function insertSection(
  sections: readonly { name: string; text: string }[],
  text: string,
): { name: string; text: string }[] {
  const entry = { name: SECTION_NAME, text };
  const anchor = sections.findIndex(
    (section) => section.name === PERSONA_PREFIX_SECTION,
  );
  if (anchor < 0) return [entry, ...sections];
  return [
    ...sections.slice(0, anchor + 1),
    entry,
    ...sections.slice(anchor + 1),
  ];
}

/**
 * 挂载插件。
 *
 * 首次 assembly 时加载 baseline 并注入 section；该文本按会话**冻结**，之后不再
 * 重算（避免替换 surface node 0 打断 KV cache）。
 *
 * 变更提醒**不归本插件管**：上游 `dsh-agent-instructions` 已负责增量检测与
 * `<system-reminder>` 投递。本插件只做"一次性把 baseline 放进 system prompt"，
 * 因此不重复实现变更通道。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const loadOptions = (
    cwd: string,
    signal: AbortSignal | undefined,
  ): LoadOptions => ({
    cwd,
    maxBytes: config.maxBytes,
    ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
    ...(config.projectRootMarkers === undefined
      ? {}
      : { projectRootMarkers: config.projectRootMarkers }),
    ...(config.maxSourceBytes === undefined
      ? {}
      : { maxSourceBytes: config.maxSourceBytes }),
    ...(config.instructionFileCandidates === undefined
      ? {}
      : { instructionFileCandidates: config.instructionFileCandidates }),
    ...(config.localInstructionFileCandidates === undefined
      ? {}
      : {
          localInstructionFileCandidates: config.localInstructionFileCandidates,
        }),
    ...(signal === undefined ? {} : { signal }),
  });

  ctx.on(
    "system-prompt/assemble",
    async (assembly: PromptAssembly, context: AssembleContext, next) => {
      const resolved = await next();
      const { agent, cwd } = factsOf(context);
      const session = agent?.session;
      if (session === undefined) return resolved;
      if (resolved.sections.some((section) => section.name === SECTION_NAME))
        return resolved;

      // 已注入过则从日志重建：读**存活的 system prompt 节点**，提取标记内的正文。
      // 这样 resume / fork 后拿到的是历史文本而非当前文件内容，渲染结果与上次
      // 逐字相同 → 上游 `SystemPromptProjection` 判定无变化 → 不替换 surface
      // node 0 → KV cache 前缀不破。
      const frozen = frozenTextFromLog(session);
      if (frozen !== undefined) {
        // 重新包上标记：提取出的是正文，而 section 文本需始终带标记，否则下一轮
        // 重建就找不到锚点（且渲染结果与首次不一致，会替换 surface node）。
        return frozen.length === 0
          ? resolved
          : {
              ...resolved,
              sections: insertSection(
                resolved.sections,
                wrapSectionText(frozen),
              ),
            };
      }

      let text: string;
      try {
        const rendered = await loadBaselineInstructions(
          loadOptions(cwd, context.signal),
          ctx.get("fs"),
        );
        if (rendered === undefined) return resolved;
        text = unwrapReminder(rendered.text);
      } catch (error) {
        // 读盘失败不应让整轮请求失败：记日志并保持系统提示词不变。
        // 不写标记：下次 assembly 仍会重试，而不是永久冻结成空。
        ctx.logger.warn(
          "instructions-as-prompt: workspace instruction load failed",
        );
        ctx.logger.warn(error);
        return resolved;
      }
      if (text.length === 0) return resolved;
      return {
        ...resolved,
        sections: insertSection(resolved.sections, wrapSectionText(text)),
      };
    },
  );
}

/**
 * 从会话日志重建冻结的指令正文。
 *
 * 扫存活的 `system/message` 节点（与上游 `SystemPromptProjection` 同一读法），
 * 从最新的非空节点里提取标记内的正文。标记由 {@link wrapSectionText} 在首次
 * 注入时写入，随 system prompt 节点一起持久化——因此无需自定义事件类型，也就
 * 不会触发持久化读路径对未知事件的拒绝。
 * @param session - 会话。
 * @returns 冻结正文；日志里没有本插件的标记时返回 undefined。
 */
function frozenTextFromLog(session: Session): string | undefined {
  const surface = new Set(session.surface.nodes);
  for (const event of session.snapshotEvents().toReversed()) {
    if (event.type !== "system/message") continue;
    if (!surface.has(event.seq)) continue;
    const content = event.data.message.content;
    const block = content.length === 1 ? content[0] : undefined;
    if (block?.type !== "text") continue;
    const extracted = extractSectionText(block.text);
    if (extracted !== undefined) return extracted;
  }
  return undefined;
}
