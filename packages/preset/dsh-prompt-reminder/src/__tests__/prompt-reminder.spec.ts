/**
 * 降级 reminder 的真实装配路径：host plane 插入的插件裁剪系统提示词（工具行在
 * preset 的 standing scope），pre-step 把被裁掉的文本作为 user 消息送达。用生产
 * AgentLoop + 真实 Agent/Session。
 * @module @morlay/dsh-prompt-reminder/__tests__
 */

import { Context } from "@deepseek-ai/cordis";
import { agentEvents, assembleContextFor } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  createMessage,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { bindScopeParent, createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent, UserMessage } from "@deepseek-ai/dsh-session";
import { PERSONA_PREFIX_SECTION, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
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

/** 摘要走桩，压缩只验证 surface 替换与重试请求的构造。 */
class StubCompaction extends BasicCompactionEngine {
  override async summarize(): Promise<{
    summary: ContentBlock[];
    provider: string;
    model: string;
  }> {
    return {
      summary: [{ type: "text", text: "RECOVERY CHECKPOINT" }],
      provider: "mock",
      model: "mock",
    };
  }
}

/** 第 2 次对话请求溢出（触发压缩），其余成功；记录每次请求的消息。 */
class OverflowAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly failures: ReadonlySet<number> = new Set([2])) {
    super();
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 64 } });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    if (this.failures.has(this.requests.length)) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: "request too large for model context",
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        },
      };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "ok" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

/** 两轮长历史，让压缩有可替换的范围。 */
function overflowHistorySeed(): readonly SessionEvent[] {
  const session = Session.create(SessionId("reminder-overflow-seed"));
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append("turn/start", { turn });
    session.append("step/start", { turn, step: 1 });
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: `history ${turn} ${"old context ".repeat(200)}` }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append(
      "assistant/message",
      {
        stream: [],
        turn,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [{ type: "text", text: `response ${turn} ${"detail ".repeat(200)}` }],
          source: { kind: "model", provider: "mock", model: "mock" },
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("step/end", { turn, step: 1 });
    session.append("turn/end", { turn, reason: { kind: "completed" } });
  }
  return session.snapshotEvents();
}

describe("压缩后的首次请求", () => {
  /** 真实 loop + 压缩 + 溢出重试的装配（默认第 2 次对话请求溢出）。 */
  async function mountOverflow(
    options: { failures?: ReadonlySet<number>; maxOverflowRetries?: number } = {},
  ) {
    const ctx = new Context();
    contexts.push(ctx);
    const adapter = new OverflowAdapter(options.failures);
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { personaPrefix: "你是一个编码专家。", personaSuffix: "交付前自检。" },
    });
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(TokenMeter);
    ctx.llm.registerAdapter(["mock"], adapter);
    ctx.on("agent/request", async (_payload, next) => ({
      ...(await next()),
      provider: "mock",
      model: "mock",
    }));
    // 最坏注册顺序：压缩引擎先注册。它在 retry 分支短路、不调 next()，本插件
    // 只有以 prepend 站在最外层才拿得到压缩完成后的 action。
    new StubCompaction(ctx, {
      thresholdRatio: 1,
      retainTokens: 100,
      maxTokens: 64,
      compactionRetries: 0,
      maxOverflowRetries: options.maxOverflowRetries ?? 1,
    });
    await ctx.plugin(plugin, {});
    // 与 preset 注册的工具说明一样，是被降级的 section（root scope 对每个 agent 可见）。
    ctx.systemPrompt.section({
      name: "tool:bash",
      order: 1000,
      text: "Check the [exit code: N] marker.",
    });
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId(`reminder-overflow-${Date.now()}-${Math.random()}`),
      seed: overflowHistorySeed(),
      agentOptions: { provider: "mock", model: "mock" },
    });
    const ask = (text: string) =>
      agent.followup(
        createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }),
      );
    return { adapter, agent, ask };
  }

  it("context overflow 压缩掉早期 reminder 后，重试请求仍带 reminder", async () => {
    const { adapter, agent, ask } = await mountOverflow();

    // turn 3 正常完成：reminder 在这里注入并落库到会话早期位置。
    ask("first question");
    await agent.whenIdle();
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain("<system-reminder>");

    // turn 4 首次请求溢出 → 压缩把 turn 3 的 reminder 换成 checkpoint → 重试。
    ask("second question");
    await agent.whenIdle();

    expect(
      agent.session.snapshotEvents().some((event) => event.type === "compaction/summary"),
    ).toBe(true);
    expect(adapter.requests).toHaveLength(3);
    // 溢出请求：压缩前，reminder 仍在历史里。
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain("<system-reminder>");
    // 压缩后的重试请求不走 pre-step，reminder 必须由 request-error 补回落库。
    const retry = JSON.stringify(adapter.requests[2]?.messages);
    expect(retry).toContain("RECOVERY CHECKPOINT");
    expect(retry).not.toContain("old context");
    expect(retry).toContain("<system-reminder>");
    expect(retry).toContain("exit code");
  });

  it("压缩只补一条，压缩之间的请求不重复注入", async () => {
    // 连续两次溢出：每次压缩都把上一条 reminder 换进摘要，因此每次都要补。
    const { adapter, agent, ask } = await mountOverflow({
      failures: new Set([2, 3]),
      maxOverflowRetries: 2,
    });
    for (const text of ["first", "second", "third", "fourth"]) {
      ask(text);
      await agent.whenIdle();
    }

    // 每份 reminder 都是全量系统提示词，重复注入就是重复开销：每个请求恰好一条。
    const remindersPerRequest = adapter.requests.map(
      (request) =>
        request.messages.filter((message) =>
          JSON.stringify(message.content).includes("<system-reminder>"),
        ).length,
    );
    expect(remindersPerRequest).toEqual([1, 1, 1, 1, 1, 1]);

    // 首次注入 + 两次压缩后各补写一条；压缩之间的正常轮不新增。被压缩覆盖的旧
    // 条目留在 append-only 日志里（不在 surface、也不进入任何请求）。
    const reminders = agent.session
      .snapshotEvents()
      .filter(
        (event) =>
          event.type === "user/message" && JSON.stringify(event.data).includes("<system-reminder>"),
      );
    expect(reminders).toHaveLength(3);
    const surface = new Set(agent.session.surface.nodes.map((seq) => Number(seq)));
    expect(reminders.filter((event) => surface.has(Number(event.seq)))).toHaveLength(1);
  });
});
