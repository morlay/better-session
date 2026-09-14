/**
 * 把精简系统提示词里被裁掉的 section 降级为 `<system-reminder>` user 消息：
 * 装配时从 assembly 移除并捕获，pre-step 时注入，内容变化才追加新 reminder。
 *
 * 与 preset 的 `persona` 行配合使用：`keep` 名单之外的 section 不再进入系统
 * 提示词，而是紧随本轮用户消息之后送达，避免工具说明稀释系统提示词。
 * @module @morlay/dsh-prompt-reminder
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  type AssembledSection,
} from "@deepseek-ai/dsh-system-prompt";
import { latestReminderText, reminderMessage, renderReminder } from "./reminder.ts";

/** Cordis 插件名。 */
export const name = "prompt-reminder";

/** 装配点依赖的系统提示词注册表。 */
export const inject = ["systemPrompt"];

/** 插件配置。 */
export interface Config {
  /** 留在系统提示词里的 section 名；其余非空 section 降级为 reminder。 */
  keep?: string[];
}

/** 运行时配置 schema。 */
export const Config: z<Config> = z.object({
  keep: z.array(z.string()).default([PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION]),
});

/** 拆出要保留的 section 与要降级的文本；空文本 section 不降级（渲染时本就丢弃）。 */
function demote(
  sections: readonly AssembledSection[],
  keep: ReadonlySet<string>,
): { sections: AssembledSection[]; texts: string[] } {
  const kept: AssembledSection[] = [];
  const texts: string[] = [];
  for (const section of sections) {
    if (keep.has(section.name) || section.text.length === 0) kept.push(section);
    else texts.push(section.text);
  }
  return { sections: kept, texts };
}

/**
 * 注册裁剪与注入。
 * @param ctx - preset 的 standing scope 上下文（覆盖该 preset 的全部 agent）。
 * @param config - 保留名单。
 */
export function apply(ctx: Context, config: Config): void {
  const keep = new Set(config.keep ?? []);
  // 本轮装配捕获的 reminder 文本，按 agent 区分（子 agent 各有自己的组合与 persona）。
  const captured = new WeakMap<Agent, string>();

  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const result = await next();
    const { sections, texts } = demote(result.sections, keep);
    const agent = context.agent;
    if (agent !== undefined) {
      if (texts.length === 0) captured.delete(agent);
      else captured.set(agent, renderReminder(texts));
    }
    return texts.length === 0 ? result : { ...result, sections };
  });

  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    const decision = await next();
    // 没有进入模型的消息时不注入：空消息列表属于 no-step turn，下一轮再试。
    if (decision.kind === "reject" || decision.messages.length === 0) return decision;
    const reminder = captured.get(agent);
    if (reminder === undefined) return decision;
    // 唯一真相是会话 surface：loop 把注入的消息落库，surface 上有同文本就
    // 不再注入。不进程内记账——rewind（retry / 编辑 / 撤回）截断掉旧
    // reminder 时，这里当场恢复，而不是等到文本变化或进程重启。
    if (latestReminderText(agent) === reminder) return decision;
    // 贴近已领取的这批消息之后：直接输入在前，注入的上下文紧随其后。
    const claimedEnd = decision.messages.findLastIndex((message) => messages.includes(message));
    return {
      ...decision,
      messages: decision.messages.toSpliced(claimedEnd + 1, 0, reminderMessage(reminder)),
    };
  });
}
