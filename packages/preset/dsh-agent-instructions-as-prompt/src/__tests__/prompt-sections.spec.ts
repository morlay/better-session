/**
 * baseline 落点测试：每个指令文件一个 section、追加在全部 section 之后、
 * 文本按会话冻结（文件改动不改写 system prompt），resume 后从日志重建。
 *
 * 用真实 cordis 上下文 + 真实 Session + SystemPrompt 走完整 assembly，不 mock
 * 上游；冻结值随 `system/message` 节点落库，因此也覆盖「落库而非内存」。
 * @module @morlay/dsh-agent-instructions-as-prompt/__tests__/prompt-sections
 */

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createSystemMessage } from "@deepseek-ai/dsh-llm";
import type { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import SessionStore, { SessionId, type Session } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as plugin from "../index.ts";
import { SECTION_NAME_PREFIX } from "../prompt.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * 存储域替身：只实现本插件用到的一面（open → table.get/put）。表按域名单例，
 * 因此两次挂载（模拟进程重启）共享同一份介质。上游 storage-domain 的 KV 语义由
 * 它自己的测试覆盖，这里只验证本插件的调用与恢复约定。
 */
function memoryStorageDomain(): DomainFacility {
  const tables = new Map<string, Map<string, unknown>>();
  return {
    open: async (spec: { name: string }) => {
      const rows = tables.get(spec.name) ?? new Map<string, unknown>();
      tables.set(spec.name, rows);
      return {
        table: () => ({
          get: (key: string) => rows.get(key),
          put: async (key: string, value: unknown) => {
            rows.set(key, value);
          },
        }),
        close: async () => {},
      };
    },
  } as unknown as DomainFacility;
}

/** 共享替身：模拟「介质跨进程仍在」，因此 resume 的第二次挂载能读到快照。 */
const storageDomain = memoryStorageDomain();

/** 建一个含 `.git` 的临时项目根。 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "prompt-sections-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** 挂载完整上下文，返回带真实 Session 的最小 agent 替身。 */
async function mount(
  root: string,
  cwd: string = root,
  overrides: Partial<Parameters<typeof plugin.apply>[1]> = {},
  seed: readonly unknown[] = [],
  /** 复用同一 id 即模拟同一会话在新进程里 resume（快照按会话 id 落盘）。 */
  id?: SessionId,
): Promise<{ ctx: Context; agent: Agent; session: Session }> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(LocalFileSystem, { cwd: "/" });
  await ctx.plugin(SystemPrompt, { personaPrefix: "你是专家。" });
  ctx.provide("storageDomain", storageDomain);
  await ctx.plugin(plugin, {
    maxBytes: 65536,
    dshHome: join(root, "no-home"),
    projectRootMarkers: [".git"],
    ...overrides,
  });
  const session = ctx.sessions.create(
    id ?? SessionId(`prompt-sections-${Date.now()}-${Math.random()}`),
    {
      meta: { cwd },
      ...(seed.length === 0 ? {} : { seed: seed as never }),
    },
  );
  return { ctx, agent: { session } as unknown as Agent, session };
}

/** 走一次完整的「装配 + 提交」，模拟上游 agent-loop 的 pre-step。 */
async function assembleAndCommit(
  ctx: Context,
  agent: Agent,
  session: Session,
): Promise<PromptAssembly> {
  const assembly = await ctx.systemPrompt.assemble({ agent });
  session.append(
    "system/message",
    {
      turn: 1,
      step: 1,
      message: createSystemMessage(renderPrompt(assembly), "@deepseek-ai/dsh-system-prompt"),
    },
    { surfaceOp: "append" },
  );
  return assembly;
}

/** 本次 assembly 里的 baseline section（按 prompt 顺序）。 */
function baselineSections(assembly: PromptAssembly): { name: string; text: string }[] {
  return assembly.sections.filter((section) => section.name.startsWith(SECTION_NAME_PREFIX));
}

describe("workspace instruction sections", () => {
  it("injects the user-global and project-root files only, after every other section", async () => {
    const root = project();
    write(root, "AGENTS.md", "# 根规则\n\nYAGNI。");
    write(root, "sub/AGENTS.md", "# 子目录规则\n\nPDCA。");
    const home = join(root, "home");
    write(home, "AGENTS.md", "# 全局规则\n\nKISS。");
    const { ctx, agent } = await mount(root, join(root, "sub"), { dshHome: home });

    const assembly = await ctx.systemPrompt.assemble({ agent });
    const sections = baselineSections(assembly);

    // 正文就是文件内容：没有 system-reminder 信封、intro 或 "Instructions from:" 标题。
    expect(sections.map((section) => section.text)).toEqual([
      "# 全局规则\n\nKISS。",
      "# 根规则\n\nYAGNI。",
    ]);
    // 子目录那份不进 system prompt（只走中途提醒通道）。
    expect(sections.map((section) => section.text).join("\n")).not.toContain("子目录规则");
    // 指令读在最后：本插件的 section 就是 assembly 的尾部。
    const names = assembly.sections.map((section) => section.name);
    expect(names.slice(-2)).toEqual([`${SECTION_NAME_PREFIX}:0`, `${SECTION_NAME_PREFIX}:1`]);
  });

  it("freezes the section text once the prompt carries it", async () => {
    const root = project();
    write(root, "AGENTS.md", "# 原始规则");
    const { ctx, agent, session } = await mount(root);
    const first = baselineSections(await assembleAndCommit(ctx, agent, session));
    expect(first[0]?.text).toContain("原始规则");

    write(root, "AGENTS.md", "# 改过的规则");
    const second = baselineSections(await assembleAndCommit(ctx, agent, session));

    expect(second).toEqual(first);
    expect(second[0]?.text).not.toContain("改过的规则");
  });

  it("reconstructs the frozen sections from the log after a fresh mount (resume)", async () => {
    const root = project();
    write(root, "AGENTS.md", "# 历史规则");
    const first = await mount(root);
    const firstText = baselineSections(
      await assembleAndCommit(first.ctx, first.agent, first.session),
    );

    write(root, "AGENTS.md", "# 新规则");
    const resumed = await mount(
      root,
      root,
      {},
      [...first.session.snapshotEvents()],
      first.session.id,
    );
    const resumedText = baselineSections(
      await resumed.ctx.systemPrompt.assemble({ agent: resumed.agent }),
    );

    expect(resumedText).toEqual(firstText);
    expect(resumedText[0]?.text).not.toContain("新规则");
  });

  it("injects nothing when no instruction file exists", async () => {
    const { ctx, agent } = await mount(project());

    expect(baselineSections(await ctx.systemPrompt.assemble({ agent }))).toEqual([]);
  });

  it("reads AGENTS.md and AGENTS.local.md by default", async () => {
    const root = project();
    write(root, "AGENTS.md", "# AGENTS 内容");
    write(root, "AGENTS.local.md", "# local overlay 内容");
    const { ctx, agent } = await mount(root);

    const text = baselineSections(await ctx.systemPrompt.assemble({ agent })).map(
      (section) => section.text,
    );
    expect(text.join("\n")).toContain("AGENTS 内容");
    expect(text.join("\n")).toContain("local overlay 内容");
  });

  it("reads CLAUDE.md too, as upstream discovery does", async () => {
    const root = project();
    write(root, "CLAUDE.md", "# CLAUDE 内容");
    const { ctx, agent } = await mount(root);

    const text = baselineSections(await ctx.systemPrompt.assemble({ agent })).map(
      (section) => section.text,
    );
    expect(text.join("\n")).toContain("CLAUDE 内容");
  });

  it("survives instruction prose that contains a prompt variable reference", async () => {
    const root = project();
    write(root, "AGENTS.md", "# 模板\n\n使用 {{projectName}} 作为项目名。");
    const { ctx, agent } = await mount(root);

    const assembly = await ctx.systemPrompt.assemble({ agent });

    // 渲染成功即证明 `{{` 已被拆开：未注册的变量引用会让 renderPrompt 抛错。
    expect(renderPrompt(assembly)).toContain("projectName");
  });

  it("writes no user-role baseline message", async () => {
    const root = project();
    write(root, "AGENTS.md", "# 不进对话");
    const { ctx, agent, session } = await mount(root);

    await assembleAndCommit(ctx, agent, session);

    expect(session.snapshotEvents().filter((event) => event.type === "user/message")).toEqual([]);
  });
});
