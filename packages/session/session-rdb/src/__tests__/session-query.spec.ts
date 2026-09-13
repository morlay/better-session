import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { EmptySettings, meta, oneTurnLog } from "@morlay/session-rdb/testing";
import { SessionQueryRdb } from "../session-query.ts";

async function harness(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  return { ctx, dispose: () => fiber.dispose() };
}

describe("session-rdb session query replacement", () => {
  const disposals: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of disposals.splice(0)) await dispose();
  });

  it("serves ctx.sessionQuery from the rdb backend", async () => {
    const { ctx, dispose } = await harness();
    disposals.push(dispose);
    expect(ctx.get("sessionQuery")).toBeInstanceOf(SessionQueryRdb);
  });

  it("keeps full-text search disabled without any derived index database", async () => {
    const { ctx, dispose } = await harness();
    disposals.push(dispose);
    const query = ctx.sessionQuery;
    // 与官方 `openAt: never` 同形：拒绝发生在请求归一化与任何索引工作之前。
    await expect(query.searchSessions({ query: "needle" })).rejects.toMatchObject({
      code: "SESSION_QUERY_SEARCH_DISABLED",
    });
    await expect(
      query.searchEvents({ sessionId: SessionId("missing"), query: "needle" }),
    ).rejects.toMatchObject({ code: "SESSION_QUERY_SEARCH_DISABLED" });
  });

  it("lists live-preferred records through the shared base engine", async () => {
    const { ctx, dispose } = await harness();
    disposals.push(dispose);
    const persistence = ctx.sessionPersistence as SessionPersistenceSqlite;
    await persistence.createAndAppend(meta("persisted"), oneTurnLog());
    ctx.sessions.create(SessionId("live"), { meta: meta("live"), seed: oneTurnLog() });

    const records = await ctx.sessionQuery.listSessions();
    const byId = new Map(records.map((record) => [String(record.header.id), record]));
    expect([...byId.keys()].sort()).toEqual(["live", "persisted"]);
    expect(byId.get("live")).toMatchObject({ live: true, persisted: false });
    expect(byId.get("persisted")).toMatchObject({ live: false, persisted: true });
  });

  it("reads exact events and titles through the shared base engine", async () => {
    const { ctx, dispose } = await harness();
    disposals.push(dispose);
    const persistence = ctx.sessionPersistence as SessionPersistenceSqlite;
    await persistence.createAndAppend(meta("exact"), oneTurnLog());

    const events = await ctx.sessionQuery.listEvents(SessionId("exact"));
    expect(events.some((event) => event.type === "user/message")).toBe(true);
    const trace = await ctx.sessionQuery.traceSession(SessionId("exact"));
    expect(String(trace.target.header.id)).toBe("exact");
    expect(trace.complete).toBe(true);
  });
});
