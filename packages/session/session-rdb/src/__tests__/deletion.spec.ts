// 已归档会话的硬删除：数据面清理、守卫（未归档 / live / 不存在）、
// 归档集退场，以及不误伤其他会话的事件行。

import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionPersistenceRdb, {
  SessionBranchRdbProvider,
  SessionDeletionError,
} from "@morlay/session-rdb";
import { SESSION_DELETE_PATH } from "@morlay/session-rdb/deletion";
import { EmptySettings, meta, oneTurnLog } from "@morlay/session-rdb/testing";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function harness(): Promise<{
  ctx: Context;
  persistence: SessionPersistenceRdb;
}> {
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
  id: string,
  events: readonly SessionEvent[] = oneTurnLog(),
  header: SessionHeader = meta(id),
): Promise<void> {
  const handle = await ctx.sessionPersistence.create(header);
  try {
    await handle.append([...events]);
  } finally {
    await handle.close();
  }
}

/** 经 storages 接管写 workspace 域状态：归档集落在会话行的 f_archived_at 上。 */
async function archive(persistence: SessionPersistenceRdb, ...ids: string[]): Promise<void> {
  await persistence.internals().backend.storage.writeWorkspaceState({
    initialized: true,
    workspaceIds: [],
    archivedSessionIds: ids.map((id) => SessionId(id)),
  });
}

async function eventCountOf(
  persistence: SessionPersistenceRdb,
  id: string,
): Promise<number> {
  return (await persistence.internals().backend.getEventRows(SessionId(id))).length;
}

describe("deleteSession", () => {
  it("removes an archived session, its events, and keeps other sessions intact", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(ctx, "keep-me");
    await createPersisted(ctx, "drop-me");
    await archive(persistence, "drop-me");

    await persistence.deleteSession(SessionId("drop-me"));

    const listed = (await persistence.list()).map((snapshot) => snapshot.header.id);
    expect(listed).toContain(SessionId("keep-me"));
    expect(listed).not.toContain(SessionId("drop-me"));
    expect(await eventCountOf(persistence, "keep-me")).toBeGreaterThan(0);
    // 会话行删除后其事件行不再被引用：孤儿清理把它一并抹掉。
    const remaining = await persistence.internals().backend.getEventRows(SessionId("drop-me"));
    expect(remaining).toEqual([]);
    // 其他会话的事件 id 未被孤儿清理误伤。
    const kept = await persistence.internals().backend.getEventRows(SessionId("keep-me"));
    for (const row of kept) expect(row.fEventId).not.toBe("");
  });

  it("rejects a session that is not archived", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(ctx, "not-archived");

    const failure = await persistence
      .deleteSession(SessionId("not-archived"))
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionDeletionError);
    expect((failure as SessionDeletionError).code).toBe("SESSION_NOT_ARCHIVED");
    expect(await eventCountOf(persistence, "not-archived")).toBeGreaterThan(0);
  });

  it("reports an unknown session", async () => {
    const { persistence } = await harness();
    await expect(persistence.deleteSession(SessionId("missing"))).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("rejects a live session until its handle closes", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(ctx, "live");
    await archive(persistence, "live");

    const handle = await persistence.open(SessionId("live"), "write");
    try {
      await expect(persistence.deleteSession(SessionId("live"))).rejects.toMatchObject({
        code: "SESSION_LIVE",
      });
    } finally {
      await handle.close();
    }
    await persistence.deleteSession(SessionId("live"));
    expect((await persistence.list()).map((snapshot) => snapshot.header.id)).not.toContain(
      SessionId("live"),
    );
  });

  it("drops the session from the workspace archive set through the registry", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(ctx, "archived-row");
    await archive(persistence, "archived-row");
    const calls: string[] = [];
    const archived: SessionId[] = [SessionId("archived-row")];
    ctx.provide("workspaceRegistry", {
      get archivedSessionIds(): readonly SessionId[] {
        return archived;
      },
      unarchiveSession: (id: SessionId) => {
        calls.push(id);
        archived.splice(0, archived.length);
        return Promise.resolve();
      },
    } as never);

    await persistence.deleteSession(SessionId("archived-row"));

    expect(calls).toEqual([SessionId("archived-row")]);
    expect(ctx.get("workspaceRegistry")).toBeDefined();
  });

  it("keeps events still referenced by a fork child", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(ctx, "parent");
    const provider = new SessionBranchRdbProvider(persistence, {
      getSession: (id) => ctx.sessions.get(id),
      getAgent: () => undefined,
      flush: (session) => ctx.sessions.flush(session),
    });
    const childId = await provider.forkFrom(SessionId("parent"), {
      childSessionId: SessionId("child"),
    });
    await archive(persistence, "parent");

    await persistence.deleteSession(SessionId("parent"));

    // 子会话复用父会话的事件行：孤儿清理不得把仍被引用的行删掉。
    const child = await persistence.readLog(childId, {});
    expect(child?.events.length ?? 0).toBeGreaterThan(0);
  });

  it("serves the deletion endpoint with status mapping", async () => {
    const { ctx, persistence } = await harness();
    await createPersisted(ctx, "drop");
    await createPersisted(ctx, "keep");
    await archive(persistence, "drop");
    const handler = await deletionRoute(ctx);

    const conflict = fakeResponse();
    await handler(fakeDeleteRequest({ sessionId: "keep" }), conflict.res);
    expect(conflict.code).toBe(409);
    expect(JSON.parse(conflict.body).code).toBe("SESSION_NOT_ARCHIVED");

    const ok = fakeResponse();
    await handler(fakeDeleteRequest({ sessionId: "drop" }), ok.res);
    expect(ok.code).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ deleted: "drop" });

    const missing = fakeResponse();
    await handler(fakeDeleteRequest({ sessionId: "drop" }), missing.res);
    expect(missing.code).toBe(404);
  });
});

/** 假 webServer/connection 注册后的删除路由（插件构造期已注册，等待注入落地）。 */
async function deletionRoute(
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
  for (let i = 0; i < 1000 && !routes.has(SESSION_DELETE_PATH); i += 1) await Promise.resolve();
  const handler = routes.get(SESSION_DELETE_PATH);
  if (handler === undefined) throw new Error("deletion route was not registered");
  return handler;
}

function fakeDeleteRequest(body: unknown): import("node:http").IncomingMessage {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield chunk;
    },
  } as unknown as import("node:http").IncomingMessage;
}

function fakeResponse(): {
  res: import("node:http").ServerResponse;
  code: number;
  body: string;
} {
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
