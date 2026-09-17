import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionSeq, SessionStore, type SessionEvent } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { EmptySettings } from "@morlay/session-rdb/testing";
import { meta } from "@morlay/session-rdb/testing";
import { orphanInboxSpliceSeqs, repairOrphanInboxSplices } from "@morlay/session-rdb/artifact";

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
    const events = [splice(0, "next-turn", 0, 0, [{ id: "a" }]), splice(1, "next-turn", 0, 1, [])];
    expect(orphanInboxSpliceSeqs(events).size).toBe(0);
  });

  it("flags an insert beyond the empty queue (rewind dropped the prior queued message)", () => {
    const events = [
      splice(0, "next-turn", 0, 0, [{ id: "queued-before-rewind" }]),
      splice(1, "next-turn", 1, 0, [{ id: "b" }]),
      splice(2, "next-turn", 0, 1, []),
      splice(3, "next-step", 0, 0, [{ id: "b" }]),
    ];

    const afterRewind = events.slice(1);
    const orphan = orphanInboxSpliceSeqs(afterRewind);

    expect(orphan.has(1)).toBe(true);
  });

  it("rewrites orphans to no-op so the stream replays from empty", () => {
    const events = [
      splice(0, "next-turn", 1, 0, [{ id: "b" }]),
      splice(1, "next-turn", 0, 1, []),
      splice(2, "next-step", 0, 0, [{ id: "c" }]),
      splice(3, "next-step", 0, 1, []),
    ];
    repairOrphanInboxSplices(events);
    expect(orphanInboxSpliceSeqs(events).size).toBe(0);

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

    const kept = events[2] as unknown as { data: { start: number; inserted: unknown[] } };
    expect(kept.data.start).toBe(0);
    expect(kept.data.inserted).toHaveLength(1);
  });

  it("flags a duplicate id across pending lists", () => {
    const events = [
      splice(0, "next-turn", 0, 0, [{ id: "x" }]),
      splice(1, "next-step", 0, 0, [{ id: "x" }]),
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
        {
          type: "turn/end",
          seq: SessionSeq(5),
          time: 6,
          data: { turn: 1, reason: { kind: "completed" } },
        },

        splice(6, "next-turn", 1, 0, [{ id: "queued-after" }]),
        splice(7, "next-turn", 0, 1, []),

        { type: "turn/start", seq: SessionSeq(8), time: 8, data: { turn: 2 } },
        splice(9, "next-turn", 0, 0, [{ id: "turn2-input" }]),
        {
          type: "user/message",
          seq: SessionSeq(10),
          time: 10,
          data: {
            id: "u2",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/start", seq: SessionSeq(11), time: 11, data: { turn: 2, step: 1 } },
      ];
      const m = meta("bad");
      await persistence.createAndAppend(m, turn);

      const handle = await persistence.open(SessionId("bad"), "read");
      const { events } = await handle.read();
      await handle.close();
      expect(events).toHaveLength(turn.length);

      expect(orphanInboxSpliceSeqs(events).size).toBe(0);

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
