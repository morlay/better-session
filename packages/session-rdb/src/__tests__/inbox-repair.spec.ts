import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  SessionSeq,
  SessionStore,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { EmptySettings } from "@morlay/session-rdb/testing";
import { meta } from "@morlay/session-rdb/testing";
import {
  orphanInboxSpliceSeqs,
  repairOrphanInboxSplices,
} from "@morlay/session-rdb/artifact";

function splice(
  seq: number,
  target: "next-turn" | "next-step",
  start: number,
  removed: number,
  inserted: Array<{ id: string }>,
): SessionEvent {
  return {
    type: "agent/inbox/spliced",
    seq: seq as never,
    time: seq,
    data: {
      target,
      start,
      removedCount: removed,
      ...(inserted.length > 0 ? { inserted } : {}),
    },
  } as unknown as SessionEvent;
}

describe("orphanInboxSpliceSeqs", () => {
  it("accepts a self-consistent splice stream", () => {
    const events = [
      splice(0, "next-turn", 0, 0, [{ id: "a" }]),
      splice(1, "next-turn", 0, 1, []),
    ];
    expect(orphanInboxSpliceSeqs(events).size).toBe(0);
  });

  it("flags an insert beyond the empty queue (rewind dropped the prior queued message)", () => {
    // 真实损坏：622 在空 next-turn 上 start:1 插入（依赖已被截断的排队消息）。
    const events = [
      splice(0, "next-turn", 0, 0, [{ id: "queued-before-rewind" }]), // 将被 rewind 删除
      splice(1, "next-turn", 1, 0, [{ id: "b" }]), // 依赖上面消息在队首
      splice(2, "next-turn", 0, 1, []), // 消费（依赖上面消息）
      splice(3, "next-step", 0, 0, [{ id: "b" }]), // b 转 next-step
    ];
    // rewind 删除了第一条插入后的流：
    const afterRewind = events.slice(1);
    const orphan = orphanInboxSpliceSeqs(afterRewind);
    // start:1 越界（队列空）→ 孤儿；后续消费/操作依赖同一消息也成孤儿。
    expect(orphan.has(1)).toBe(true);
  });

  it("rewrites orphans to no-op so the stream replays from empty", () => {
    const events = [
      splice(0, "next-turn", 1, 0, [{ id: "b" }]), // 越界插入
      splice(1, "next-turn", 0, 1, []), // 越界消费
      splice(2, "next-step", 0, 0, [{ id: "c" }]), // 独立合法操作
      splice(3, "next-step", 0, 1, []), // 消费 c
    ];
    repairOrphanInboxSplices(events);
    expect(orphanInboxSpliceSeqs(events).size).toBe(0);
    // no-op：target 保留、空操作。
    const fixed = events[0] as unknown as {
      data: { target: string; start: number; removedCount: number; inserted: unknown[] };
    };
    expect(fixed.data.target).toBe("next-turn");
    expect(fixed.data.start).toBe(0);
    expect(fixed.data.removedCount).toBe(0);
    expect(fixed.data.inserted).toEqual([]);
    const fixed1 = events[1] as unknown as {
      data: { target: string; start: number; removedCount: number };
    };
    expect(fixed1.data.target).toBe("next-turn");
    expect(fixed1.data.removedCount).toBe(0);
    // 独立合法操作不受影响。
    const kept = events[2] as unknown as { data: { start: number; inserted: unknown[] } };
    expect(kept.data.start).toBe(0);
    expect(kept.data.inserted).toHaveLength(1);
  });

  it("flags a duplicate id across pending lists", () => {
    const events = [
      splice(0, "next-turn", 0, 0, [{ id: "x" }]),
      splice(1, "next-step", 0, 0, [{ id: "x" }]), // x 已在 next-turn
    ];
    expect(orphanInboxSpliceSeqs(events).has(1)).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function harness() {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  const persistence = ctx.sessionPersistence as unknown as SessionPersistenceSqlite;
  return { ctx, persistence, dispose: () => fiber.dispose() };
}

describe("loadStored repairs orphan inbox splices", () => {
  it("returns a stream the upstream Inbox can replay after a rewind dropped the queued insert", async () => {
    const { persistence, dispose } = await harness();
    try {
      // 构造：turn 1 完整 + 被 rewind 破坏的 inbox 序列（排队插入被删，
      // 残留 start:1 插入与消费）——模拟真实损坏（f7b23e56 的 622 场景）。
      const turn: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(1),
          time: 2,
          data: {
            id: "u1",
            role: "user",
            content: [{ type: "text", text: "hi" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
        {
          type: "assistant/message",
          seq: SessionSeq(3),
          time: 4,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "a1",
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
        { type: "turn/end", seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: "completed" } } },
        // 损坏区：空 next-turn 上的 start:1 插入（原排队消息已被 rewind 删）
        splice(6, "next-turn", 1, 0, [{ id: "queued-after" }]),
        splice(7, "next-turn", 0, 1, []),
        // 后续正常轮
        { type: "turn/start", seq: SessionSeq(8), time: 8, data: { turn: 2 } },
        splice(9, "next-turn", 0, 0, [{ id: "turn2-input" }]),
        { type: "user/message", seq: SessionSeq(10), time: 10, data: { id: "u2", role: "user", content: [{ type: "text", text: "go on" }], source: { kind: "user" } }, surfaceOp: "append" } as SessionEvent,
        { type: "step/start", seq: SessionSeq(11), time: 11, data: { turn: 2, step: 1 } },
      ];
      const m = meta("bad");
      await persistence.create(m);
      await persistence.append(SessionId("bad"), turn);

      // loadStored（resume/prepare 的读取路径）应内存修复孤儿 splice。
      const stored = await persistence.loadStored(SessionId("bad"));
      expect(stored).toBeDefined();
      expect(stored!.events).toHaveLength(turn.length);
      // 孤儿 splice 被改写为 no-op：修复后按上游 Inbox 相同的增量规则
      // （start/removedCount 越界 + 跨列表重复 id）扫描无孤儿——等价可重放。
      expect(orphanInboxSpliceSeqs(stored!.events).size).toBe(0);
      // 未修复的原始流（绕过 loadStored）仍含孤儿——修复确实发生。
      const raw = await persistence.internals().backend.getEventRows(SessionId("bad"));
      const rawEvents = raw.map((row) => ({
        type: row.fType,
        seq: row.fSequence,
        time: row.fCreatedAt,
        data: JSON.parse(row.fData),
      })) as SessionEvent[];
      expect(orphanInboxSpliceSeqs(rawEvents).size).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });
});
