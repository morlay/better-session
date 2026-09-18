// GC 通道闭环：POST /api/session.gc 先让所有运行中的 agent 退场，再回收孤儿 subagent 会话与
// 孤儿事件行、最后 VACUUM；结果回报删除数量与停止的 agent 数，且重复执行幂等。
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore, type SessionHeader } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionPersistenceRdb from "@morlay/session-rdb";
import { SESSION_GC_PATH } from "@morlay/session-rdb/gc";
import { EmptySettings, meta, oneTurnLog } from "@morlay/session-rdb/testing";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

interface FakeAgent {
  cancel: ReturnType<typeof vi.fn>;
  whenIdle: ReturnType<typeof vi.fn>;
}

function fakeAgent(): FakeAgent {
  return { cancel: vi.fn(), whenIdle: vi.fn(async () => {}) };
}

async function harness(
  agents: FakeAgent[],
): Promise<{ ctx: Context; persistence: SessionPersistenceRdb }> {
  const ctx = new Context();
  ctx.provide("agents", { list: () => agents });
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path: ":memory:" });
  disposers.push(() => fiber.dispose());
  return { ctx, persistence: ctx.sessionPersistence as SessionPersistenceRdb };
}

async function createPersisted(
  ctx: Context,
  id: string,
  header: SessionHeader = meta(id),
): Promise<void> {
  const handle = await ctx.sessionPersistence.create(header);
  try {
    await handle.append([...oneTurnLog()]);
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
      // GC 不带请求体。
    },
  } as unknown as import("node:http").IncomingMessage;
}

async function gcRoute(
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
  for (let i = 0; i < 1000 && !routes.has(SESSION_GC_PATH); i += 1) await Promise.resolve();
  const handler = routes.get(SESSION_GC_PATH);
  if (handler === undefined) throw new Error("gc route was not registered");
  return handler;
}

describe("GC 通道", () => {
  it("先停 agent，再回收孤儿事件行并 VACUUM", async () => {
    const running = [fakeAgent(), fakeAgent()];
    const { ctx, persistence } = await harness(running);
    await createPersisted(ctx, "keep-me");
    await createPersisted(ctx, "drop-me");
    await archive(persistence, "drop-me");
    await persistence.deleteSession(SessionId("drop-me"));
    const handler = await gcRoute(ctx);

    const response = fakeResponse();
    await handler(fakeRequest(), response.res);

    expect(response.code).toBe(200);
    const value = JSON.parse(response.body) as {
      orphanEvents: number;
      stoppedAgents: number;
      vacuumed: boolean;
    };
    expect(value.orphanEvents).toBeGreaterThan(0);
    expect(value.stoppedAgents).toBe(2);
    expect(value.vacuumed).toBe(true);
    for (const agent of running) {
      expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" }, { keepInbox: true });
      expect(agent.whenIdle).toHaveBeenCalled();
    }
  });

  it("回收父已不存在的 subagent 会话，父还在的不动", async () => {
    const { ctx, persistence } = await harness([]);
    await createPersisted(ctx, "parent");
    await createPersisted(ctx, "child-alive", {
      ...meta("child-alive"),
      parentSession: SessionId("parent"),
      origin: "subagent",
    });
    await createPersisted(ctx, "child-orphan", {
      ...meta("child-orphan"),
      parentSession: SessionId("gone"),
      origin: "subagent",
    });
    const handler = await gcRoute(ctx);

    const response = fakeResponse();
    await handler(fakeRequest(), response.res);

    const value = JSON.parse(response.body) as {
      orphanSessions: number;
      orphanEvents: number;
    };
    expect(value.orphanSessions).toBe(1);
    // 被回收的 subagent 会话独占的事件行也在同一次 GC 里清掉。
    expect(value.orphanEvents).toBeGreaterThan(0);

    const listed = (await persistence.list()).map((snapshot) => String(snapshot.header.id));
    expect(listed).toContain("parent");
    expect(listed).toContain("child-alive");
    expect(listed).not.toContain("child-orphan");

    const second = fakeResponse();
    await handler(fakeRequest(), second.res);
    expect((JSON.parse(second.body) as { orphanSessions: number }).orphanSessions).toBe(0);
  });

  it("重复执行幂等：第二次没有孤儿可回收", async () => {
    const { ctx, persistence } = await harness([]);
    await createPersisted(ctx, "keep-me");
    await createPersisted(ctx, "drop-me");
    await archive(persistence, "drop-me");
    await persistence.deleteSession(SessionId("drop-me"));
    const handler = await gcRoute(ctx);

    await handler(fakeRequest(), fakeResponse().res);
    const second = fakeResponse();
    await handler(fakeRequest(), second.res);

    expect(second.code).toBe(200);
    expect((JSON.parse(second.body) as { orphanEvents: number }).orphanEvents).toBe(0);
  });
});
