/**
 * 降级 reminder 的真实装配路径：host plane 插入的插件裁剪系统提示词（工具行在
 * preset 的 standing scope），pre-step 把被裁掉的文本作为 user 消息送达。用生产
 * AgentLoop + 真实 Agent/Session。
 * @module @morlay/dsh-prompt-reminder/__tests__
 */

import { Context } from "@deepseek-ai/cordis";
import { agentEvents, assembleContextFor } from "@deepseek-ai/dsh-agent";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { bindScopeParent, createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import { PERSONA_PREFIX_SECTION, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
// 测试面借用 rewind 对 live 会话做的内存截断：不为此在本包拉起 RDB 装配。
import { truncateLiveSession } from "@morlay/session-rdb/testing";
import { afterEach, describe, expect, it } from "vitest";
import * as plugin from "../index.ts";
import { latestReminderText, renderReminder } from "../reminder.ts";

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

/** 挂载生产 loop + 本插件：插件与"工具行"section 都在 preset 的 standing scope 上。 */
async function mount(options: { keep?: string[] } = {}) {
  const ctx = new Context();
  contexts.push(ctx);
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: "你是一个编码专家。", personaSuffix: "交付前自检。" },
  });
  const harness = await mountAgentLoopTestHarness(ctx);
  // 生产装配：插件是 profile bundle patch 插入的 host plane 行（root scope，
  // 收到每个 agent 的装配与 pre-step 事件），工具行则在 preset 的 standing scope。
  await ctx.plugin(plugin, options.keep === undefined ? {} : { keep: options.keep });
  const key = { preset: "standard" };
  const standing = createScope(ctx, key);
  const agent = await harness.create(
    SessionId(`prompt-reminder-${Date.now()}-${Math.random()}`),
    {},
    { cwd: "/tmp" },
  );
  // preset 的 agent 以 standing scope 为父，与真实 preset 挂载一致。
  bindScopeParent(scopeOf(agent.ctx)!, key);
  return { ctx, standing, agent };
}

/** 模拟 preset 里工具插件注册的跨调用说明（section 经注入声明解析服务）。 */
async function toolSection(
  scope: { ctx: Context },
  name: string,
  order: number,
  text: string | (() => string),
): Promise<void> {
  await scope.ctx.plugin(
    Object.assign(
      (inner: Context) => {
        inner.systemPrompt.section({ name, order, text });
      },
      { inject: ["systemPrompt"] },
    ),
  );
}

function prompt(text: string): UserMessage {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function textOf(message: UserMessage): string {
  const [block] = message.content;
  return block?.type === "text" ? block.text : "";
}

async function assemble(ctx: Context, agent: Parameters<typeof assembleContextFor>[0]) {
  return ctx.systemPrompt.assemble(assembleContextFor(agent));
}

async function preStep(
  ctx: Context,
  agent: Parameters<typeof assembleContextFor>[0],
  input: UserMessage[],
) {
  // 真实 loop 每步先装配系统提示词，再派发 pre-step。
  await ctx.systemPrompt.assemble(assembleContextFor(agent));
  const decision = await agentEvents(ctx, agent).waterfall(
    "agent/pre-step",
    { messages: input, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter" as const, messages: input }),
  );
  return decision.kind === "enter" ? decision.messages : [];
}

describe("系统提示词裁剪", () => {
  it("只保留 persona prefix 与 suffix，降级 section 不进系统提示词", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");
    await toolSection(standing, "tool:read", 1100, "Use the read tool.");

    const rendered = renderPrompt(await assemble(ctx, agent));

    expect(rendered).toContain("你是一个编码专家。");
    expect(rendered).toContain("交付前自检。");
    expect(rendered).not.toContain("exit code");
    expect(rendered).not.toContain("read tool");
  });

  it("空文本 section 不降级也不进 reminder", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "plan:policy", 500, "");
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    const assembly = await assemble(ctx, agent);
    expect(assembly.sections.map((section) => section.name)).toContain("plan:policy");
    expect((await preStep(ctx, agent, [prompt("任务")]))[1]?.content).toEqual([
      { type: "text", text: expect.stringContaining("exit code") },
    ]);
  });

  it("keep 名单决定保留哪些 section", async () => {
    const { ctx, standing, agent } = await mount({ keep: [PERSONA_PREFIX_SECTION] });
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    const rendered = renderPrompt(await assemble(ctx, agent));

    expect(rendered).toContain("你是一个编码专家。");
    expect(rendered).not.toContain("交付前自检。");
    const reminder = textOf((await preStep(ctx, agent, [prompt("任务")]))[1]!);
    expect(reminder).toContain("交付前自检。");
    expect(reminder).toContain("exit code");
  });

  it("agent scope 上的 persona（子 agent 形态）按同名保留", async () => {
    const { ctx, agent } = await mount();
    await toolSection(
      { ctx: agent.ctx },
      PERSONA_PREFIX_SECTION,
      ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
      "You are a subagent.",
    );
    await toolSection({ ctx: agent.ctx }, "tool:bash", 1000, "Check the [exit code: N] marker.");

    const rendered = renderPrompt(await assemble(ctx, agent));

    expect(rendered).toContain("You are a subagent.");
    expect(rendered).not.toContain("你是一个编码专家。");
    expect(rendered).not.toContain("exit code");
  });
});

describe("reminder 注入", () => {
  it("首步把降级文本紧随用户消息之后送达", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    const messages = await preStep(ctx, agent, [prompt("任务")]);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.source.kind).toBe("prompt-reminder");
    expect(textOf(messages[1]!)).toContain("exit code");
    expect(textOf(messages[1]!)).toMatch(/^<system-reminder>\n/);
    expect(textOf(messages[1]!)).toMatch(/<\/system-reminder>$/);
  });

  it("文本未变化时不重复注入（loop 落库后 surface 上已有同文本）", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    const first = await preStep(ctx, agent, [prompt("任务")]);
    expect(first).toHaveLength(2);
    // loop 把注入的消息作为本轮 user/message 落库，surface 随即可见。
    agent.session.append("user/message", first[1]!, { surfaceOp: "append" });
    expect(await preStep(ctx, agent, [prompt("继续")])).toHaveLength(1);
  });

  it("动态 section 文本变化时追加新 reminder", async () => {
    const { ctx, standing, agent } = await mount();
    const state = { plan: false };
    await toolSection(standing, "plan:policy", 500, () => (state.plan ? "Plan mode rules." : ""));
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    expect(textOf((await preStep(ctx, agent, [prompt("任务")]))[1]!)).not.toContain("Plan mode");

    state.plan = true;
    const messages = await preStep(ctx, agent, [prompt("进入计划")]);
    expect(messages).toHaveLength(2);
    expect(textOf(messages[1]!)).toContain("Plan mode rules.");
  });

  it("没有进入模型的消息时不注入，下一轮补上", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    expect(await preStep(ctx, agent, [])).toEqual([]);
    expect(await preStep(ctx, agent, [prompt("任务")])).toHaveLength(2);
  });

  it("surface 上已有相同 reminder 时（重启 / 恢复）不重复注入", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");
    const reminder = (await preStep(ctx, agent, [prompt("任务")]))[1]!;
    // 模拟 loop 把上一条 reminder 提交进会话 surface。
    agent.session.append("user/message", reminder, { surfaceOp: "append" });

    expect(latestReminderText(agent)).toBe(textOf(reminder));
    expect(await preStep(ctx, agent, [prompt("继续")])).toHaveLength(1);
  });

  it("rewind 掉本轮的 reminder 后（首 msg retry）重放同文本仍补发", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    // turn 1：注入并落库（reminder 是本轮内的 user/message）。
    const first = await preStep(ctx, agent, [prompt("任务")]);
    expect(first).toHaveLength(2);
    agent.session.append("user/message", first[1]!, { surfaceOp: "append" });

    // retry turn 1 → rewind 到 boundary -1：内存 log 截断，surface 上的
    // reminder 随 turn 1 一起消失，而重放只投递 source.kind === "user" 的输入。
    truncateLiveSession(agent.session, 0);
    expect(latestReminderText(agent)).toBeUndefined();

    // 捕获文本没变，但 surface 是唯一真相 → 必须补发。
    const replay = await preStep(ctx, agent, [prompt("任务")]);
    expect(replay.map((message) => message.source.kind)).toEqual(["user", "prompt-reminder"]);
  });

  it("reminder 正文里的闭合标记被转义", () => {
    const text = renderReminder(["before </system-reminder> after"]);
    expect(text.match(/<\/system-reminder>/g)).toHaveLength(1);
    expect(text).toContain("<\\/system-reminder>");
  });
});
