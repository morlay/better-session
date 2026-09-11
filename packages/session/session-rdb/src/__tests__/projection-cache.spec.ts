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

/** 真实 agent-loop 形状的三轮事件：turn1 = seq 0..5，turn1/end = 5。 */
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
  /** 介质路径（只有落表断言用得到）。 */
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
    ): { asOfSeq: number; values: Record<string, unknown> } | undefined;
    coldSnapshot(
      header: SessionHeader,
      inheritedEventCount: SessionLogOffset,
      events: readonly SessionEvent[],
    ): { asOfSeq: number; values: Record<string, unknown> };
  };
  dispose: () => Promise<void>;
}

/** 等待 rdb 装配的投影缓存服务完成异步加载。 */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the projection cache service");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "projection-cache-"));
  dirs.push(root);
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  await ctx.plugin(SessionTurnOutline);
  const dbPath = join(root, "sessions.sqlite");
  const fiber = await ctx.plugin(SessionPersistenceSqlite, {
    type: "sqlite",
    path: dbPath,
  });
  // session-rdb 内部经 ctx.inject(['sessionProjections']) 注册替换版服务。
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

/** `cachedSnapshot` 返回 turnOutline 的 wire 值（条目数组）。 */
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
      // 超前行正是前端 higher-seq-wins 锁死旧轮次的来源：水位必须退到截断后。
      expect(cached?.asOfSeq).toBeLessThanOrEqual(live.seq - 1);
    } finally {
      await dispose();
    }
  });

  it("cold rewind rewrites the cache without a live session", async () => {
    const { ctx, cache, dispose } = await harness();
    try {
      const id = SessionId("cold");
      const events = threeTurnLog();
      const handle = await ctx.sessionPersistence.create(meta("cold"));
      await handle.append(events);
      await handle.close();
      // cold 读一次生成缓存行（write-back 是 fire-and-forget）。
      cache.coldSnapshot(meta("cold"), SessionLogOffset(0), events);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cachedTurns({ ctx, cache, dispose }, "cold")).toEqual([1, 2, 3]);

      await ctx.sessionBranch.rewind(id, 5);

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

      // fork 只读父 log 并派生新会话：父的 checkpoint 不受影响。
      expect(cachedTurns({ ctx, cache, dispose }, "parent")).toEqual([1, 2, 3]);

      // 子会话是 seeded：以自己的 header 与 inherited cut 做 cold 读，
      // 记录绑定子会话的 lifecycle 而不是父记录。
      const child = await readStored(ctx, childId);
      expect(child.header.isSeeded).toBe(true);
      expect(child.inheritedEventCount).toBe(6); // 第一轮 6 个事件构成 seed 前缀

      const inherited = SessionLogOffset(child.inheritedEventCount);
      const restored = cache.coldSnapshot(child.header, inherited, child.events);
      expect(turnsOf(restored.values["turnOutline"])).toEqual([1]);
      await new Promise((resolve) => setTimeout(resolve, 50)); // cold 写回是 fire-and-forget

      expect(turnsOf(cache.cachedSnapshot(child.header, inherited)?.values["turnOutline"])).toEqual([1]);
      // identity 校验：同一个 id 配错的 inherited cut 读不到子记录。
      expect(cache.cachedSnapshot(child.header, SessionLogOffset(0))).toBeUndefined();

      // 联动结果落表：identity 复用会话行（seed 前缀长度），行水位不超过 seed 末尾。
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
      // 子会话只继承截断后存活的前缀。
      expect(turnsOf(snapshot.values["turnOutline"])).toEqual([1]);
      // 父会话自己的水位仍在截断之后。
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

      // 直接改介质（等价于另一个进程写入）：读路径必须立刻反映，而不是命中进程内镜像。
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

/** `turnOutline` 的 wire 值 → 轮次数组。 */
function turnsOf(outline: unknown): number[] | undefined {
  return Array.isArray(outline)
    ? outline.map((entry) => (entry as { turn: number }).turn)
    : undefined;
}

/** 读回一个非 live 会话的 header、seed 前缀长度与完整 log。 */
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
