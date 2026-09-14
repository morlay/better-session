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

  it("文本未变化时不重复注入", async () => {
    const { ctx, standing, agent } = await mount();
    await toolSection(standing, "tool:bash", 1000, "Check the [exit code: N] marker.");

    expect(await preStep(ctx, agent, [prompt("任务")])).toHaveLength(2);
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

  it("reminder 正文里的闭合标记被转义", () => {
    const text = renderReminder(["before </system-reminder> after"]);
    expect(text.match(/<\/system-reminder>/g)).toHaveLength(1);
    expect(text).toContain("<\\/system-reminder>");
  });
});
