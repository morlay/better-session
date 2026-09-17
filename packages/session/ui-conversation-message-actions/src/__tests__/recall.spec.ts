import { describe, expect, it } from "vitest";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import {
  assistantMessage,
  createPersisted,
  harness,
  meta,
  oneTurnLog,
  turnLog,
  twoTurnLog,
  SessionIdBrand,
  SessionSeq,
  userMessage,
  type SessionEvent,
} from "@morlay/ui-conversation-message-actions/testing";

function rdb(ctx: import("@deepseek-ai/cordis").Context): SessionPersistenceSqlite {
  return ctx.sessionPersistence as SessionPersistenceSqlite;
}

interface EventRow {
  fSequence: number;
  fType: string;
}

async function eventRows(
  ctx: import("@deepseek-ai/cordis").Context,
  id: SessionIdBrand,
): Promise<EventRow[]> {
  const backend = (
    ctx.sessionPersistence as unknown as {
      internals(): {
        backend: { getEventRows(id: SessionIdBrand): Promise<EventRow[]> };
      };
    }
  ).internals().backend;
  return backend.getEventRows(id);
}

function textOf(event: SessionEvent): string | undefined {
  return (event.data as { content?: Array<{ text?: string }> }).content?.[0]?.text;
}

describe("SessionEditor recall", () => {
  it("recalls a closed-turn first user message: rewinds to the previous turn/end, no version effect", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());

      const result = await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: 7,
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));
      expect(result.queuedTurns).toBe(0);

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(rows[5]?.fType).toBe("turn/end");

      expect(rows.some((r) => r.fType === "session-branch/version")).toBe(false);

      const after = await rdb(ctx).load(SessionIdBrand("src"));
      expect(after.events.filter((e) => e.type === "user/message")).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("recalls the first turn's user message: clears the whole log (boundary -1)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", oneTurnLog());

      await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: 1,
      });

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("recalls a first user message in an open turn: whole-turn rewind, no orphan turn/start", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
        { type: "step/start", seq: SessionSeq(13), time: 13, data: { turn: 3, step: 1 } },
        userMessage(14, "turn3-user", "go on", 14),
        assistantMessage(15, 3, 1, "turn3-assistant", "partial", 15),
        { type: "step/end", seq: SessionSeq(16), time: 16, data: { turn: 3, step: 1 } },
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: 14,
      });

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(rows[11]?.fType).toBe("turn/end");

      expect(rows.some((r) => r.fSequence >= 12)).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("recalls a mid-turn followup of a closed turn without deleting the whole turn", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      const turn2: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(7), time: 8, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(8), time: 9, data: { turn: 2, step: 1 } },
        userMessage(9, "turn2-user", "q1", 10),
        assistantMessage(10, 2, 1, "turn2-assistant", "ans0", 11),
        { type: "step/end", seq: SessionSeq(11), time: 12, data: { turn: 2, step: 1 } },
        { type: "step/start", seq: SessionSeq(12), time: 13, data: { turn: 2, step: 2 } },
        userMessage(13, "turn2-followup", "followup", 14),
        { type: "step/end", seq: SessionSeq(14), time: 15, data: { turn: 2, step: 2 } },
        {
          type: "turn/end",
          seq: SessionSeq(15),
          time: 16,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await createPersisted(ctx, "src", [header, ...first, ...turn2]);

      await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: 13,
      });

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(rows.some((r) => r.fSequence === 12)).toBe(false);

      const after = await rdb(ctx).load(SessionIdBrand("src"));
      expect(after.events.some((e) => textOf(e) === "q1")).toBe(true);
      expect(after.events.some((e) => textOf(e) === "followup")).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("stops a busy live agent's loop before rewinding", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("busy"), {
        meta: meta("busy"),
        seed: [header, ...first],
      });
      const live = ctx.sessions.get(SessionIdBrand("busy"))!;
      await ctx.sessions.flush(live);
      const before = live.snapshotEvents().length;

      let releaseIdle: () => void = () => {};
      const idlePromise = new Promise<void>((resolve) => {
        releaseIdle = resolve;
      });
      const calls: string[] = [];
      const cancels: Array<{ cause: unknown; options: unknown }> = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("busy")
            ? {
                session: live,
                followup: () => {},
                cancel: (cause: unknown, options: unknown) => {
                  calls.push("cancel");
                  cancels.push({ cause, options });
                },
                whenIdle: () => {
                  calls.push("whenIdle");
                  return idlePromise;
                },
                inbox: { clear: () => {} },
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      const recalling = editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("busy"),
        eventSeq: 2,
      });

      for (let i = 0; i < 1000 && !calls.includes("whenIdle"); i += 1) await Promise.resolve();
      expect(calls).toEqual(["cancel", "whenIdle"]);

      expect(cancels[0]).toEqual({ cause: { kind: "user" }, options: { keepInbox: true } });
      expect(live.snapshotEvents()).toHaveLength(before);

      releaseIdle();
      const result = await recalling;
      expect(result.sessionId).toBe(SessionIdBrand("busy"));
      expect(live.snapshotEvents()).toEqual([]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("rejects recalling an assistant message", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());

      await expect(
        editor.recall({
          action: "recall",
          sessionId: SessionIdBrand("src"),
          eventSeq: 9,
        }),
      ).rejects.toThrow(/不可撤回/);

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows).toHaveLength(12);
    } finally {
      await dispose();
    }
  });

  it("recalls a message outside every turn: truncates from that message on", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const outside = userMessage(0, "outside", "queued then stopped", 1);
      await createPersisted(ctx, "src", [outside, ...turnLog(1, 1)]);

      await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: 0,
      });

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("recalls a message between two turns without touching the earlier turn", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const log = [
        ...turnLog(0, 1),
        userMessage(6, "between", "between turns", 7),
        ...turnLog(7, 2),
      ];
      await createPersisted(ctx, "src", log);

      await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: 6,
      });

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(rows[5]?.fType).toBe("turn/end");

      expect(rows.some((r) => r.fType === "session-branch/version")).toBe(false);
    } finally {
      await dispose();
    }
  });
});
