/**
 * 冻结语义测试：baseline 只在首次 assembly 注入 section，之后文件变化**不**改动
 * section（KV cache 前缀稳定），而是经 reminder 通道投递。
 *
 * 用真实 cordis 上下文 + 真实 Session + SystemPrompt 走完整 assembly，不 mock
 * 上游；冻结值经投影从日志重建，因此这里也覆盖「落库而非内存」这一性质。
 * @module @morlay/dsh-instructions-as-prompt/__tests__/freeze
 */

import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId, type Session } from "@deepseek-ai/dsh-session";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { createSystemMessage } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as instructionsAsPrompt from "../index.ts";
import { MARKER_BEGIN, SECTION_NAME, extractSectionText } from "../index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 建一个含 AGENTS.md 的临时项目。 */
function project(agents: string): string {
  const root = mkdtempSync(join(tmpdir(), "freeze-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), agents);
  return root;
}

/**
 * 挂载完整上下文，返回带**真实 Session** 的最小 agent 替身。
 *
 * agent 只需 `session`：插件读 `session.header.cwd`、`session.append()` 与投影
 * `stateOf(session, ...)`，这些都是真实 Session 提供的能力。
 */
async function mount(
  root: string,
  /** 覆盖插件配置；省略候选字段即测**默认值**（只认 AGENTS.md 系列）。 */
  overrides: Partial<Parameters<typeof instructionsAsPrompt.apply>[1]> = {},
  /** 已持久化的事件（模拟 resume：从日志重建而非重新读盘）。 */
  seed: readonly unknown[] = [],
): Promise<{ ctx: Context; agent: Agent; session: Session }> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(LocalFileSystem, { cwd: "/" });
  await ctx.plugin(SystemPrompt, { personaPrefix: "你是专家。" });
  await ctx.plugin(instructionsAsPrompt, {
    maxBytes: 65536,
    dshHome: join(root, "no-home"),
    projectRootMarkers: [".git"],
    ...overrides,
  });
  const session = ctx.sessions.create(SessionId(`freeze-${Date.now()}-${Math.random()}`), {
    meta: { cwd: root },
    ...(seed.length === 0 ? {} : { seed: seed as never }),
  });
  const agent = { session } as unknown as Agent;
  return { ctx, agent, session };
}

/**
 * 走一次完整的「装配 + 提交」：`assemble()` 后把渲染结果作为 `system/message`
 * 落库，模拟上游 `agent-loop` 的 `preStep`。
 *
 * 单独调 `assemble()` 不会产生日志事件——`system/message` 由 agent-loop 提交。
 * 本插件的冻结值依赖该节点持久化，故测试必须复刻这一步。
 * @returns 本次 assembly。
 */
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

/**
 * 取某次 assembly 里工作区指令 section 的**正文**（去掉包裹标记）。
 *
 * 产物带 {@link MARKER_BEGIN}/`end` 标记——那是持久化重建的锚点，不是给模型看
 * 的内容，故断言前提取正文。
 */
function sectionText(sections: readonly { name: string; text: string }[]): string | undefined {
  const raw = sections.find((section) => section.name === SECTION_NAME)?.text;
  return raw === undefined ? undefined : extractSectionText(raw);
}

describe("frozen baseline", () => {
  it("injects the instructions section on the first assembly", async () => {
    const { ctx, agent } = await mount(project("# 规则\n\nYAGNI 是行为规范。"));
    const text = sectionText((await ctx.systemPrompt.assemble({ agent })).sections);
    expect(text).toContain("YAGNI 是行为规范");
  });

  it("places the section after the deployment persona", async () => {
    const { ctx, agent } = await mount(project("# 规则"));
    const names = (await ctx.systemPrompt.assemble({ agent })).sections.map((s) => s.name);
    expect(names.indexOf(SECTION_NAME)).toBeGreaterThan(names.indexOf("deployment:persona-prefix"));
  });

  it("keeps the section text frozen after the file changes", async () => {
    const root = project("# 原始规则");
    const { ctx, agent, session } = await mount(root);
    const first = sectionText((await assembleAndCommit(ctx, agent, session)).sections);
    expect(first).toContain("原始规则");

    // 改写文件后再次装配：冻结值从 system/message 节点重建，故 section 不变。
    writeFileSync(join(root, "AGENTS.md"), "# 改过的规则");
    const second = sectionText((await assembleAndCommit(ctx, agent, session)).sections);
    expect(second).toBe(first);
    expect(second).not.toContain("改过的规则");
  });

  it("writes no custom event type (persistence would reject it)", async () => {
    const { ctx, agent, session } = await mount(project("# 落库检查"));
    await ctx.systemPrompt.assemble({ agent });
    // 关键：不得写自定义事件类型。上游 `Session.append()` 不写 `ignorable`，
    // 而持久化读路径会拒绝未知类型（"unknown to this harness and not marked
    // ignorable"）。冻结值靠 system prompt 节点自身携带。
    const unknown = session
      .snapshotEvents()
      .filter((event) => event.type.startsWith("instructions-as-prompt/"));
    expect(unknown).toHaveLength(0);
  });

  it("carries the frozen text inside the system prompt node", async () => {
    const { ctx, agent, session } = await mount(project("# 标记检查"));
    await assembleAndCommit(ctx, agent, session);
    // 标记随 system/message 节点持久化，因此可从日志提取（resume 后重建冻结值）。
    const systemNodes = session
      .snapshotEvents()
      .filter((event) => event.type === "system/message")
      .map((event) => event.data.message.content[0])
      .filter((block) => block?.type === "text")
      .map((block) => block.text);
    const carrying = systemNodes.filter((text) => text.includes(MARKER_BEGIN));
    expect(carrying).toHaveLength(1);
    expect(extractSectionText(carrying[0]!)).toContain("标记检查");
  });

  it("reconstructs the frozen text from the log after a fresh mount (resume)", async () => {
    // 模拟 resume：文件已改，但新进程从日志重建 → 仍是历史文本，且渲染结果与
    // 首次逐字相同（上游据此判定无变化，不替换 surface node）。
    const root = project("# 历史规则");
    const first = await mount(root);
    const firstText = sectionText(
      (await assembleAndCommit(first.ctx, first.agent, first.session)).sections,
    );
    expect(firstText).toContain("历史规则");

    writeFileSync(join(root, "AGENTS.md"), "# 新规则");
    // 新上下文 + 同一份日志（把事件种进去，等价于持久化后重新加载）。
    const events = [...first.session.snapshotEvents()];
    const resumed = await mount(root, {}, events);
    const resumedText = sectionText(
      (await resumed.ctx.systemPrompt.assemble({ agent: resumed.agent })).sections,
    );
    expect(resumedText).toBe(firstText);
    expect(resumedText).not.toContain("新规则");
  });

  it("does not inject when no instruction file exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "freeze-empty-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    const { ctx, agent } = await mount(root);
    expect(sectionText((await ctx.systemPrompt.assemble({ agent })).sections)).toBeUndefined();
  });
});

describe("default candidates", () => {
  it("reads AGENTS.md by default", async () => {
    const { ctx, agent } = await mount(project("# AGENTS 内容"));
    expect(sectionText((await ctx.systemPrompt.assemble({ agent })).sections)).toContain(
      "AGENTS 内容",
    );
  });

  it("ignores CLAUDE.md by default", async () => {
    // 本插件只认 AGENTS.md 系列；CLAUDE.md 不参与发现。
    const root = mkdtempSync(join(tmpdir(), "freeze-claude-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "CLAUDE.md"), "# CLAUDE 内容");
    const { ctx, agent } = await mount(root);
    expect(sectionText((await ctx.systemPrompt.assemble({ agent })).sections)).toBeUndefined();
  });

  it("ignores CLAUDE.local.md by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "freeze-claude-local-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "CLAUDE.local.md"), "# CLAUDE local 内容");
    const { ctx, agent } = await mount(root);
    expect(sectionText((await ctx.systemPrompt.assemble({ agent })).sections)).toBeUndefined();
  });

  it("reads AGENTS.local.md by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "freeze-agents-local-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "AGENTS.local.md"), "# local overlay 内容");
    const { ctx, agent } = await mount(root);
    expect(sectionText((await ctx.systemPrompt.assemble({ agent })).sections)).toContain(
      "local overlay 内容",
    );
  });
});
