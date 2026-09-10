import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import SessionProjectionCache from "@deepseek-ai/dsh-session-projection-cache";
import * as SessionTurnOutline from "@deepseek-ai/dsh-session-turn-outline";
import Storage from "@deepseek-ai/dsh-storage";
import * as StorageDomain from "@deepseek-ai/dsh-storage-domain";
import * as StorageJson from "@deepseek-ai/dsh-storage-json";
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
    ): unknown;
  };
  dispose: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "projection-cache-"));
  dirs.push(root);
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(Storage);
  await ctx.plugin(StorageJson, { root });
  await ctx.plugin(StorageDomain, { backend: "json" });
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1000, writeIntervalMs: 1000 });
  await ctx.plugin(SessionTurnOutline);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  return {
    ctx,
    cache: ctx.get("sessionProjectionCache") as Harness["cache"],
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

describe("rewind refreshes the persisted projection cache", () => {
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
});
