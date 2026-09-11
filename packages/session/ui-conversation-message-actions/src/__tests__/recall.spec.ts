import { describe, expect, it } from "vitest";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import {
  assistantMessage,
  createPersisted,
  harness,
  meta,
  oneTurnLog,
  twoTurnLog,
  SessionIdBrand,
  SessionSeq,
  userMessage,
  type SessionEvent,
} from "@morlay/ui-conversation-message-actions/testing";

/** 类型收窄：ctx.sessionPersistence 到 RDB 子类（便捷方法面）。 */
function rdb(ctx: import("@deepseek-ai/cordis").Context): SessionPersistenceSqlite {
  return ctx.sessionPersistence as SessionPersistenceSqlite;
}

interface EventRow {
  fSequence: number;
  fType: string;
}

/** 读取落盘行（截断验证的权威视图）。 */
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

      // 轮 2 的轮首 user（eventSeq 7）→ boundary = 轮 1 的 turn/end（5）。
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
      // 撤回不写版本效果：交给用户重新发送，不产生派生版本记录。
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
      // 轮 1/2 闭合（0..11）+ 轮 3 未闭合（turn/start 12，user 14）。
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
      // 悬空 turn/start 与轮 3 内容一并截断，下一次发送从干净边界续接。
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

      // followup（eventSeq 13）→ rewind 到该消息本身（exclusive drop），
      // 保留轮首 q1 与回复；孤儿 step/start 12 由 rewind 平衡化剔除。
      await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: 13,
      });

      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(rows.some((r) => r.fSequence === 12)).toBe(false);

      const after = await rdb(ctx).load(SessionIdBrand("src"));
      expect(after.events.some((e) => textOf(e) === "q1")).toBe(true);
      expect(after.events.some((e) => textOf(e) === "followup")).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("waits for a busy live agent to settle BEFORE rewinding", async () => {
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

      let releaseIdle: () => void = () => {};
      const idlePromise = new Promise<void>((resolve) => {
        releaseIdle = resolve;
      });
      let idleWaited = false;
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("busy")
            ? {
                session: live,
                followup: () => {},
                whenIdle: () => {
                  idleWaited = true;
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
      await Promise.resolve();
      expect(idleWaited).toBe(true);
      // 释放 agent → 撤回继续完成，live 内存 log 清空。
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

      // eventSeq 9 是轮 2 的 assistant/message，不是可撤回的用户输入。
      await expect(
        editor.recall({
          action: "recall",
          sessionId: SessionIdBrand("src"),
          eventSeq: 9,
        }),
      ).rejects.toThrow(/不可撤回/);
      // 拒绝不截断会话（原子：失败不丢数据）。
      const rows = await eventRows(ctx, SessionIdBrand("src"));
      expect(rows).toHaveLength(12);
    } finally {
      await dispose();
    }
  });
});
