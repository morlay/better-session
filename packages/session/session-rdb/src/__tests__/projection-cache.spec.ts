import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import * as SessionTurnOutline from "@deepseek-ai/dsh-session-turn-outline";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { EmptySettings, meta } from "@morlay/session-rdb/testing";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function threeTurnLog(): SessionEvent[] {
  const events: SessionEvent[] = [];
  const push = (type: string, data: unknown, extra?: Record<string, unknown>): void => {
    events.push({
      type,
      seq: SessionSeq(events.length),
      time: events.length + 1,
      data,
      ...extra,
    } as SessionEvent);
  };
  for (let turn = 1; turn <= 3; turn += 1) {
    push("turn/start", { turn });
    push("step/start", { turn, step: 1 });
    push(
      "user/message",
      {
        id: `u${String(turn)}`,
        role: "user",
        content: [{ type: "text", text: `turn ${String(turn)} input` }],
        source: { kind: "user" },
      },
      { surfaceOp: "append" },
    );
    push(
      "assistant/message",
      {
        turn,
        step: 1,
        message: {
          id: `a${String(turn)}`,
          role: "assistant",
          content: [{ type: "text", text: `answer ${String(turn)}` }],
          source: { kind: "model", provider: "mock", model: "mock" },
        },
        stream: [],
      },
      { surfaceOp: "append" },
    );
    push("step/end", { turn, step: 1 });
    push("turn/end", { turn, reason: { kind: "completed" } });
  }
  return events;
}

interface Harness {
  ctx: Context;

  dbPath?: string;
  cache: {
    write(session: {
      id: SessionId;
      header: SessionHeader;
      inheritedEventCount: SessionLogOffset;
      snapshotEvents(): readonly SessionEvent[];
    }): Promise<void>;
    cachedSnapshot(
      header: SessionHeader,
      inheritedEventCount: SessionLogOffset,
      keys?: readonly string[],
    ): { asOfSeq: number; values: Record<string, unknown> } | undefined;
    coldSnapshot(
      header: SessionHeader,
      inheritedEventCount: SessionLogOffset,
      events: readonly SessionEvent[],
    ): { asOfSeq: number; values: Record<string, unknown> };
  };
  dispose: () => Promise<void>;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the projection cache service");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function harness(root?: string): Promise<Harness> {
  const dir = root ?? (await mkdtemp(join(tmpdir(), "projection-cache-")));
  if (root === undefined) dirs.push(dir);
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  await ctx.plugin(SessionTurnOutline);
  const dbPath = join(dir, "sessions.sqlite");
  const fiber = await ctx.plugin(SessionPersistenceSqlite, {
    type: "sqlite",
    path: dbPath,
  });

  const cache = await waitFor(
    () => ctx.get("sessionProjectionCache") as Harness["cache"] | undefined,
  );
  return {
    ctx,
    dbPath,
    cache,
    dispose: () => fiber.dispose(),
  };
}

function cachedTurns(harness: Harness, id: string): number[] | undefined {
  const live = harness.ctx.sessions.get(SessionId(id));
  const header = live?.header ?? meta(id);
  const inherited = live?.inheritedEventCount ?? SessionLogOffset(0);
  const outline = harness.cache.cachedSnapshot(header, inherited)?.values["turnOutline"];
  return Array.isArray(outline)
    ? outline.map((entry) => (entry as { turn: number }).turn)
    : undefined;
}

describe("session-rdb projection cache replacement", () => {
  it("checkpoints a newly created session without an explicit write", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const id = SessionId("created");

      ctx.sessions.create(id, {
        meta: meta("created"),
        seed: [
          {
            type: "permission/preset",
            seq: SessionSeq(0),
            time: 1,
            data: { preset: "workspace-write" },
          },
        ] as never,
      });
      const live = ctx.sessions.get(id)!;
      const snapshot = await waitFor(() =>
        cache.cachedSnapshot(live.header, live.inheritedEventCount),
      );
      expect(snapshot.values).toHaveProperty("turnOutline");
    } finally {
      await dispose();
    }
  });

  it("advances the checkpoint on turn/end without an explicit write", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const id = SessionId("turn-end");

      ctx.sessions.create(id, { meta: meta("turn-end"), seed: threeTurnLog().slice(0, 6) });
      const turns = await waitFor(() => {
        const value = cachedTurns({ ctx, cache, dispose }, "turn-end");
        return value !== undefined && value.length > 0 ? value : undefined;
      });
      expect(turns).toEqual([1]);
    } finally {
      await dispose();
    }
  });

  it("keeps the host list blank flag correct for a newly created session", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      const passthrough = { parse: (value: unknown) => value } as never;
      ctx.sessionProjections.register({
        key: "sessionListMetadata",
        stateSchema: passthrough,
        init: () => ({ blank: true, lastPromptAt: null }),
        apply: (
          state: { blank: boolean; lastPromptAt: number | null },
          event: { type: string },
        ) => ({
          blank: state.blank && event.type !== "turn/start",
          lastPromptAt: state.lastPromptAt,
        }),
        wire: { viewSchema: passthrough, view: (state: unknown) => state },
        stateVersion: 1,
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const id = SessionId("blank");
      const live = ctx.sessions.create(id, {
        meta: meta("blank"),
        seed: [
          {
            type: "permission/preset",
            seq: SessionSeq(0),
            time: 1,
            data: { preset: "workspace-write" },
          },
        ] as never,
      });

      const blankOf = (): boolean => {
        const snapshot = cache.cachedSnapshot(live.header, live.inheritedEventCount);
        const metadata = snapshot?.values["sessionListMetadata"] as { blank?: boolean } | undefined;
        return metadata?.blank ?? false;
      };
      await waitFor(
        () =>
          cache.cachedSnapshot(live.header, live.inheritedEventCount)?.values[
            "sessionListMetadata"
          ],
      );
      expect(blankOf()).toBe(true);

      live.append("turn/start", { turn: 1 });
      live.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      await waitFor(() => (blankOf() ? undefined : true));
      expect(blankOf()).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("serves the title column when the checkpoint rows carry no title", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const id = SessionId("titled");

      ctx.sessions.create(id, {
        meta: meta("titled"),
        seed: [
          ...threeTurnLog(),
          {
            type: "session/title",
            seq: SessionSeq(18),
            time: 19,
            data: { title: "直取标题", messageSeqs: [], source: "auto" },
          } as never,
        ],
      });
      const live = ctx.sessions.get(id)!;
      await ctx.sessions.flush(live);
      await waitFor(() => cache.cachedSnapshot(live.header, live.inheritedEventCount));

      const withTitle = cache.cachedSnapshot(live.header, live.inheritedEventCount, ["title"]);
      expect(withTitle?.values["title"]).toBe("直取标题");

      const withoutTitle = cache.cachedSnapshot(live.header, live.inheritedEventCount, [
        "turnOutline",
      ]);
      expect(withoutTitle?.values["title"]).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("prunes stale snapshots whose watermark predates the stored log", async () => {
    const root = await mkdtemp(join(tmpdir(), "projection-cache-stale-"));
    dirs.push(root);
    const staleCount = (dbPath: string): number => {
      const db = new DatabaseSync(dbPath);
      try {
        return (
          db.prepare("SELECT COUNT(*) AS c FROM t_session_projcache_row").get() as { c: number }
        ).c;
      } finally {
        db.close();
      }
    };

    const first = await harness(root);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const id = SessionId("stale");
      first.ctx.sessions.create(id, { meta: meta("stale"), seed: threeTurnLog() });
      const live = first.ctx.sessions.get(id)!;
      await first.ctx.sessions.flush(live);
      await waitFor(() => first.cache.cachedSnapshot(live.header, live.inheritedEventCount));
      expect(staleCount(first.dbPath!)).toBeGreaterThan(0);

      const db = new DatabaseSync(first.dbPath!);
      try {
        db.exec("UPDATE t_session_projcache_row SET f_seq = -1");
      } finally {
        db.close();
      }
    } finally {
      await first.dispose();
    }

    const second = await harness(root);
    try {
      await waitFor(() => (staleCount(second.dbPath!) === 0 ? true : undefined));
      expect(second.cache.cachedSnapshot(meta("stale"), SessionLogOffset(0))).toBeUndefined();
    } finally {
      await second.dispose();
    }
  });

  it("serves checkpoints written by the live write path", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      const id = SessionId("live");
      ctx.sessions.create(id, { meta: meta("live"), seed: threeTurnLog() });
      const live = ctx.sessions.get(id)!;
      await ctx.sessions.flush(live);
      await cache.write(live);
      expect(cachedTurns({ ctx, cache, dispose }, "live")).toEqual([1, 2, 3]);
    } finally {
      await dispose();
    }
  });

  it("live rewind drops the pre-truncation rows from the cache", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      const id = SessionId("live");
      ctx.sessions.create(id, { meta: meta("live"), seed: threeTurnLog() });
      const live = ctx.sessions.get(id)!;
      await ctx.sessions.flush(live);
      await cache.write(live);
      expect(cachedTurns({ ctx, cache, dispose }, "live")).toEqual([1, 2, 3]);

      await ctx.sessionBranch.rewind(id, 5);

      const cached = cache.cachedSnapshot(live.header, live.inheritedEventCount);
      expect(cachedTurns({ ctx, cache, dispose }, "live")).toEqual([1]);

      expect(cached?.asOfSeq).toBeLessThanOrEqual(live.seq - 1);
    } finally {
      await dispose();
    }
  });

  it("cold rewind invalidates the cache instead of folding the log again", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      const id = SessionId("cold");
      const events = threeTurnLog();
      const handle = await ctx.sessionPersistence.create(meta("cold"));
      await handle.append(events);
      await handle.close();

      cache.coldSnapshot(meta("cold"), SessionLogOffset(0), events);
      await waitFor(() => cachedTurns({ ctx, cache, dispose }, "cold"));
      expect(cachedTurns({ ctx, cache, dispose }, "cold")).toEqual([1, 2, 3]);

      await ctx.sessionBranch.rewind(id, 5);

      // 失效：零 I/O 读不再返回截断前的旧值（重建交给读路径，rewind 不 fold 日志）
      expect(cachedTurns({ ctx, cache, dispose }, "cold")).toBeUndefined();

      // 读路径重建出截断后的正确值
      const reader = await ctx.sessionPersistence.open(id, "read");
      const truncated = (await reader.read()).events;
      await reader.close();
      cache.coldSnapshot(meta("cold"), SessionLogOffset(0), truncated);
      await waitFor(() => cachedTurns({ ctx, cache, dispose }, "cold"));
      expect(cachedTurns({ ctx, cache, dispose }, "cold")).toEqual([1]);
    } finally {
      await dispose();
    }
  });

  it("forkFrom leaves the parent checkpoint and gives the child its own identity", async () => {
    const { ctx, cache, dbPath, dispose } = await harness();
    try {
      const parentId = SessionId("parent");
      ctx.sessions.create(parentId, { meta: meta("parent"), seed: threeTurnLog() });
      const parent = ctx.sessions.get(parentId)!;
      await ctx.sessions.flush(parent);
      await cache.write(parent);
      expect(cachedTurns({ ctx, cache, dispose }, "parent")).toEqual([1, 2, 3]);

      const childId = SessionId("child");
      await ctx.sessionBranch.forkFrom(parentId, { atSeq: 5, childSessionId: childId });

      expect(cachedTurns({ ctx, cache, dispose }, "parent")).toEqual([1, 2, 3]);

      const child = await readStored(ctx, childId);
      expect(child.header.isSeeded).toBe(true);
      expect(child.inheritedEventCount).toBe(6);

      const inherited = SessionLogOffset(child.inheritedEventCount);
      const restored = cache.coldSnapshot(child.header, inherited, child.events);
      expect(turnsOf(restored.values["turnOutline"])).toEqual([1]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(turnsOf(cache.cachedSnapshot(child.header, inherited)?.values["turnOutline"])).toEqual(
        [1],
      );

      expect(cache.cachedSnapshot(child.header, SessionLogOffset(0))).toBeUndefined();

      const db = new DatabaseSync(dbPath!);
      try {
        const head = db
          .prepare("SELECT f_seed_length FROM t_sessions WHERE f_session_id = 'child'")
          .get() as { f_seed_length: number };
        expect(head.f_seed_length).toBe(6);
        const row = db
          .prepare(
            "SELECT f_seq FROM t_session_projcache_row WHERE f_session_id = 'child' AND f_key = 'turnOutline'",
          )
          .get() as { f_seq: number };
        expect(row.f_seq).toBeLessThanOrEqual(5);
      } finally {
        db.close();
      }
    } finally {
      await dispose();
    }
  });

  it("fork after a rewind seeds only the surviving prefix", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      const parentId = SessionId("parent");
      ctx.sessions.create(parentId, { meta: meta("parent"), seed: threeTurnLog() });
      const parent = ctx.sessions.get(parentId)!;
      await ctx.sessions.flush(parent);
      await cache.write(parent);

      await ctx.sessionBranch.rewind(parentId, 5);
      expect(cachedTurns({ ctx, cache, dispose }, "parent")).toEqual([1]);

      const childId = SessionId("child");
      await ctx.sessionBranch.forkFrom(parentId, { atSeq: 5, childSessionId: childId });
      const child = await readStored(ctx, childId);
      const snapshot = cache.coldSnapshot(
        child.header,
        SessionLogOffset(child.inheritedEventCount),
        child.events,
      );

      expect(turnsOf(snapshot.values["turnOutline"])).toEqual([1]);

      expect(cachedTurns({ ctx, cache, dispose }, "parent")).toEqual([1]);
    } finally {
      await dispose();
    }
  });

  it("serves checkpoints straight from the medium, not an in-process mirror", async () => {
    const { ctx, cache, dbPath, dispose } = await harness();
    try {
      const id = SessionId("live");
      ctx.sessions.create(id, { meta: meta("live"), seed: threeTurnLog() });
      const live = ctx.sessions.get(id)!;
      await ctx.sessions.flush(live);
      await cache.write(live);
      expect(cachedTurns({ ctx, cache, dispose }, "live")).toEqual([1, 2, 3]);

      const db = new DatabaseSync(dbPath!);
      try {
        const row = db
          .prepare(
            "SELECT f_key, f_ver, f_seq, f_val FROM t_session_projcache_row " +
              "WHERE f_session_id = 'live' AND f_key = 'turnOutline'",
          )
          .get() as { f_key: string; f_ver: number; f_seq: number; f_val: string };
        db.prepare(
          "DELETE FROM t_session_projcache_row WHERE f_session_id = 'live' AND f_key = 'turnOutline'",
        ).run();
        expect(cachedTurns({ ctx, cache, dispose }, "live")).toBeUndefined();
        db.prepare(
          "INSERT INTO t_session_projcache_row (f_session_id, f_key, f_ver, f_seq, f_val) VALUES (?, ?, ?, ?, ?)",
        ).run("live", row.f_key, row.f_ver, row.f_seq, row.f_val);
      } finally {
        db.close();
      }
      expect(cachedTurns({ ctx, cache, dispose }, "live")).toEqual([1, 2, 3]);
    } finally {
      await dispose();
    }
  });
});

function turnsOf(outline: unknown): number[] | undefined {
  return Array.isArray(outline)
    ? outline.map((entry) => (entry as { turn: number }).turn)
    : undefined;
}

async function readStored(
  ctx: Context,
  id: SessionId,
): Promise<{
  header: SessionHeader;
  inheritedEventCount: number;
  events: readonly SessionEvent[];
}> {
  const persistence = ctx.sessionPersistence as unknown as {
    internals(): {
      readFrom(
        id: SessionId,
        fromSeq: number,
      ): Promise<{
        meta: SessionHeader;
        inheritedEventCount: number;
        events: readonly SessionEvent[];
      }>;
    };
  };
  const stored = await persistence.internals().readFrom(id, 0);
  return {
    header: stored.meta,
    inheritedEventCount: stored.inheritedEventCount,
    events: stored.events,
  };
}
