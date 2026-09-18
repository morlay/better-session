// 用量统计口径闭环：POST /api/session.usage 按事件行去重（fork 共享行只算一次）、
// 排除无会话引用的孤儿行，并把 subagent 会话的消耗单独拆出；另给按天×模型的桶与按会话的行。
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionPersistenceRdb from "@morlay/session-rdb";
import { SESSION_USAGE_PATH } from "@morlay/session-rdb/usage";
import { EmptySettings, meta, oneTurnLog } from "@morlay/session-rdb/testing";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/** 一天：便于造出两个不同的日期桶（具体日期由本地时区决定，断言只比结构）。 */
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_ONE = 1_788_852_417_912;
const DAY_TWO = DAY_ONE + DAY_MS;

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

function usageOf(input: number, output: number, cacheRead = 0, reasoning = 0): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadTokens: cacheRead,
    reasoningTokens: reasoning,
  };
}

/** 一轮对话，assistant 消息带用量与模型来源，事件时间落在指定时刻。 */
function turnWithUsage(
  time: number,
  model: { provider: string; model: string },
  usage: Usage,
): SessionEvent[] {
  return oneTurnLog().map((event) => {
    if (event.type !== "assistant/message") return { ...event, time } as SessionEvent;
    const data = event.data as unknown as { message: Record<string, unknown> };
    return {
      ...event,
      time,
      data: {
        ...event.data,
        message: { ...data.message, source: { kind: "model", ...model } },
        usage,
      },
    } as unknown as SessionEvent;
  });
}

async function harness(): Promise<{ ctx: Context; persistence: SessionPersistenceRdb }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path: ":memory:" });
  disposers.push(() => fiber.dispose());
  return { ctx, persistence: ctx.sessionPersistence as SessionPersistenceRdb };
}

async function createPersisted(
  ctx: Context,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const handle = await ctx.sessionPersistence.create(header);
  try {
    await handle.append([...events]);
  } finally {
    await handle.close();
  }
}

async function archive(persistence: SessionPersistenceRdb, ...ids: string[]): Promise<void> {
  await persistence.internals().backend.storage.writeWorkspaceState({
    initialized: true,
    workspaceIds: [],
    archivedSessionIds: ids.map((id) => SessionId(id)),
  });
}

interface UsageTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

interface UsageBucket extends UsageTotals {
  day: string;
  provider: string | null;
  model: string | null;
  subagent: boolean;
}

interface UsageSessionRow extends UsageTotals {
  sessionId: string;
  title: string | null;
  subagent: boolean;
  archived: boolean;
}

interface UsageReport {
  totals: UsageTotals;
  subagent: UsageTotals;
  buckets: UsageBucket[];
  sessions: UsageSessionRow[];
}

interface Response {
  res: import("node:http").ServerResponse;
  code: number;
  body: string;
}

function fakeResponse(): Response {
  const state = {
    res: undefined as unknown as import("node:http").ServerResponse,
    code: 0,
    body: "",
  };
  state.res = {
    writeHead: (code: number) => {
      state.code = code;
      return state.res;
    },
    end: (chunk?: string) => {
      if (chunk !== undefined) state.body = chunk;
    },
  } as unknown as import("node:http").ServerResponse;
  return state;
}

function fakeRequest(): import("node:http").IncomingMessage {
  return {
    method: "POST",
    headers: {},
    async *[Symbol.asyncIterator]() {
      // 统计请求不带请求体。
    },
  } as unknown as import("node:http").IncomingMessage;
}

async function usageRoute(
  ctx: Context,
): Promise<(req: unknown, res: unknown) => void | Promise<void>> {
  const routes = new Map<string, (req: unknown, res: unknown) => void | Promise<void>>();
  ctx.provide("webServer", {
    register: (route: {
      path: string;
      handler: (req: unknown, res: unknown) => void | Promise<void>;
    }) => {
      routes.set(route.path, route.handler);
      return () => {};
    },
  });
  ctx.provide("connection", { requestRejection: () => undefined });
  for (let i = 0; i < 1000 && !routes.has(SESSION_USAGE_PATH); i += 1) await Promise.resolve();
  const handler = routes.get(SESSION_USAGE_PATH);
  if (handler === undefined) throw new Error("usage route was not registered");
  return handler;
}

async function report(ctx: Context): Promise<UsageReport> {
  const handler = await usageRoute(ctx);
  const response = fakeResponse();
  await handler(fakeRequest(), response.res);
  expect(response.code).toBe(200);
  return JSON.parse(response.body) as UsageReport;
}

describe("用量统计口径", () => {
  it("总览按事件行去重，并把 subagent 会话的消耗单独拆出", async () => {
    const { ctx } = await harness();
    await createPersisted(
      ctx,
      meta("human"),
      turnWithUsage(
        DAY_ONE,
        { provider: "deepseek-official", model: "v4" },
        usageOf(100, 10, 1_000, 5),
      ),
    );
    await createPersisted(
      ctx,
      { ...meta("child"), origin: "subagent", parentSession: SessionId("human") },
      turnWithUsage(DAY_ONE, { provider: "deepseek-official", model: "v4" }, usageOf(50, 5)),
    );

    const value = await report(ctx);

    expect(value.totals).toMatchObject({
      events: 2,
      inputTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 1_000,
      reasoningTokens: 5,
    });
    expect(value.subagent).toMatchObject({ events: 1, inputTokens: 50, outputTokens: 5 });
  });

  it("按天 × 模型 × subagent 分桶", async () => {
    const { ctx } = await harness();
    await createPersisted(
      ctx,
      meta("human"),
      turnWithUsage(DAY_ONE, { provider: "provider-a", model: "m-a" }, usageOf(100, 10)),
    );
    await createPersisted(
      ctx,
      meta("other"),
      turnWithUsage(DAY_TWO, { provider: "provider-b", model: "m-b" }, usageOf(7, 3)),
    );

    const value = await report(ctx);

    expect(value.buckets).toHaveLength(2);
    const days = new Set(value.buckets.map((bucket) => bucket.day));
    expect(days.size).toBe(2);
    for (const day of days) expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const secondDay = value.buckets.find((bucket) => bucket.inputTokens === 7);
    expect(secondDay).toMatchObject({ provider: "provider-b", model: "m-b", subagent: false });
  });

  it("按会话列出用量，并带上子代理与归档标记", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(
      ctx,
      meta("human"),
      turnWithUsage(DAY_ONE, { provider: "p", model: "m" }, usageOf(100, 10)),
    );
    await createPersisted(
      ctx,
      { ...meta("child"), origin: "subagent", parentSession: SessionId("human") },
      turnWithUsage(DAY_ONE, { provider: "p", model: "m" }, usageOf(50, 5)),
    );
    await archive(persistence, "child");

    const value = await report(ctx);

    const byId = new Map(value.sessions.map((row) => [row.sessionId, row]));
    expect(byId.get("human")).toMatchObject({ subagent: false, archived: false, inputTokens: 100 });
    expect(byId.get("child")).toMatchObject({ subagent: true, archived: true, inputTokens: 50 });
  });

  it("被删除会话留下的事件行（无引用）不计入统计", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(
      ctx,
      meta("drop-me"),
      turnWithUsage(DAY_ONE, { provider: "p", model: "m" }, usageOf(999, 99)),
    );
    await archive(persistence, "drop-me");
    await persistence.deleteSession(SessionId("drop-me"));

    const value = await report(ctx);

    expect(value.totals.events).toBe(0);
    expect(value.totals.inputTokens).toBe(0);
    expect(value.sessions).toEqual([]);
  });
});
