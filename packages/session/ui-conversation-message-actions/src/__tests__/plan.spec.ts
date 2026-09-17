import { describe, expect, it } from "vitest";
import { SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import {
  closedTurns,
  editableMessages,
  editPlan,
  precedingContentIndex,
  recallBoundary,
  retryPlan,
  rerollPlan,
  retryableTurns,
} from "@morlay/ui-conversation-message-actions/plan";
import {
  assistantMessage,
  oneTurnLog,
  turnLog,
  twoTurnLog,
  userMessage,
} from "@morlay/ui-conversation-message-actions/testing";

function emptyTurn(base: number, turn: number): SessionEvent[] {
  return [
    { type: "turn/start", seq: SessionSeq(base), time: base, data: { turn } },
    {
      type: "turn/end",
      seq: SessionSeq(base + 1),
      time: base + 1,
      data: { turn, reason: { kind: "completed" } },
    },
  ] as SessionEvent[];
}

describe("closedTurns", () => {
  it("folds two complete turns", () => {
    const turns = closedTurns(twoTurnLog());
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(turns[0]).toMatchObject({ startSeq: 0, endSeq: 5, closed: true });
    expect(turns[1]).toMatchObject({ startSeq: 6, endSeq: 11, closed: true });
  });

  it("keeps an open turn (no turn/end) with closed: false", () => {
    const turns = closedTurns(turnLog(0, 1, { closed: false }));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn: 1, closed: false });
    expect(turns[0]?.endSeq).toBeUndefined();
  });

  it("records every mid-turn user message (followups) in turn.users", () => {
    const log = turnLog(0, 1, {
      users: [
        { id: "u1", text: "first" },
        { id: "u2", text: "followup" },
      ],
    });
    const [turn] = closedTurns(log);
    expect(turn?.users.map((u) => (u.data as { id: string }).id)).toEqual(["u1", "u2"]);
    expect(turn?.user?.seq).toBe(2);
    expect(turn?.users).toHaveLength(2);
  });

  it("ignores non-user-sourced messages", () => {
    const log = turnLog(0, 1, { closed: false });
    const steering: SessionEvent = {
      type: "user/message",
      seq: 99 as never,
      time: 1,
      data: {
        id: "steer",
        role: "user",
        content: [{ type: "text", text: "steer" }],
        source: { kind: "steering" },
      },
    } as unknown as SessionEvent;
    const [turn] = closedTurns([...log, steering]);
    expect(turn?.users).toHaveLength(1);
    expect((turn!.users[0]!.data as { id: string }).id).toBe("t1-u1");
  });
});

describe("editableMessages", () => {
  const log = twoTurnLog();

  it("enumerates user text blocks of every turn", () => {
    const blocks = editableMessages(closedTurns(log));
    const users = blocks.filter((b) => b.kind === "user");
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ turn: 1, eventSeq: 1, blockIndex: 0, text: "hi" });
  });

  it("enumerates closed-turn assistant response blocks only", () => {
    const blocks = editableMessages(closedTurns(log));
    const responses = blocks.filter((b) => b.kind === "assistant.response");
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ turn: 1, eventSeq: 3, blockIndex: 0, text: "hello" });
  });

  it("does not expose assistant blocks of an open turn (streaming partial)", () => {
    const open = turnLog(0, 1, { closed: false });
    const blocks = editableMessages(closedTurns(open));
    expect(blocks.filter((b) => b.kind.startsWith("assistant"))).toHaveLength(0);
    expect(blocks.filter((b) => b.kind === "user")).toHaveLength(1);
  });

  it("exposes every followup user block of a closed turn", () => {
    const log = turnLog(0, 1, {
      users: [
        { id: "u1", text: "first" },
        { id: "u2", text: "followup" },
      ],
    });
    const blocks = editableMessages(closedTurns(log));
    expect(blocks.filter((b) => b.kind === "user").map((b) => b.text)).toEqual([
      "first",
      "followup",
    ]);
  });
});

describe("retryableTurns", () => {
  it("lists closed turns with a user preview", () => {
    const turns = retryableTurns(closedTurns(twoTurnLog()));
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(turns[0]?.preview).toBe("hi");
    expect(turns[0]?.userEventSeq).toBe(1);
  });

  it("excludes open turns", () => {
    const log = [...twoTurnLog(), ...turnLog(12, 3, { closed: false })];
    const turns = retryableTurns(closedTurns(log));
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
  });
});

describe("editPlan", () => {
  const sessionId = "s1" as never;

  it("edits the first user of a closed turn → whole-turn rewind (no rewindBoundary)", () => {
    const log = turnLog(0, 1);
    const plan = editPlan(
      {
        action: "edit",
        sessionId,
        eventSeq: 2,
        blockIndex: 0,
        text: "edited q",
        cascade: "truncate",
      },
      closedTurns(log),
    );
    expect(plan.anchorSeq).toBe(0);
    expect(plan.rewindBoundary).toBeUndefined();
    expect(plan.queuedUsers).toHaveLength(1);
    expect((plan.queuedUsers[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "edited q",
    );
  });

  it("edits a mid-turn followup of a closed turn → message-level rewind, earlier inputs kept", () => {
    const log = turnLog(0, 1, {
      users: [
        { id: "u1", text: "first" },
        { id: "u2", text: "followup" },
      ],
    });

    const followupSeq = log.find(
      (e) => e.type === "user/message" && (e.data as { id: string }).id === "u2",
    )!.seq;
    const plan = editPlan(
      {
        action: "edit",
        sessionId,
        eventSeq: followupSeq,
        blockIndex: 0,
        text: "edited f",
        cascade: "truncate",
      },
      closedTurns(log),
    );
    expect(plan.rewindBoundary).toBe(followupSeq);
    expect(plan.queuedUsers).toHaveLength(1);
    expect((plan.queuedUsers[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "edited f",
    );
  });

  it("edits the first user of an open turn → whole-turn rewind (no rewindBoundary)", () => {
    const log = turnLog(0, 1, { closed: false });
    const plan = editPlan(
      {
        action: "edit",
        sessionId,
        eventSeq: 2,
        blockIndex: 0,
        text: "edited q",
        cascade: "truncate",
      },
      closedTurns(log),
    );

    expect(plan.rewindBoundary).toBeUndefined();
  });

  it("preserve cascade queues downstream turn inputs after the edited one", () => {
    const log = [...twoTurnLog(), ...turnLog(12, 3)];
    const plan = editPlan(
      {
        action: "edit",
        sessionId,
        eventSeq: 1,
        blockIndex: 0,
        text: "q1 edited",
        cascade: "preserve",
      },
      closedTurns(log),
    );

    expect(plan.queuedUsers).toHaveLength(3);
  });

  it("edits a closed-turn assistant response → manualTurn with replacement", () => {
    const log = turnLog(0, 1);
    const plan = editPlan(
      {
        action: "edit",
        sessionId,
        eventSeq: 3,
        blockIndex: 0,
        text: "answer edited",
        cascade: "truncate",
      },
      closedTurns(log),
    );
    expect(plan.manualTurn).toBeDefined();
    expect(plan.manualTurn?.turn).toBe(1);
    const assistant = plan.manualTurn!.assistant;
    expect((assistant.content[0] as { text: string }).text).toBe("answer edited");
  });

  it("rejects an eventSeq beyond the last turn (no matching turn)", () => {
    expect(() =>
      editPlan(
        { action: "edit", sessionId, eventSeq: 0, blockIndex: 0, text: "x", cascade: "truncate" },
        closedTurns([]),
      ),
    ).toThrow(/不属于已落定回合/);
  });

  it("rejects an unknown eventSeq inside an open turn", () => {
    const log = turnLog(0, 1, { closed: false });
    expect(() =>
      editPlan(
        { action: "edit", sessionId, eventSeq: 99, blockIndex: 0, text: "x", cascade: "truncate" },
        closedTurns(log),
      ),
    ).toThrow(/不存在或不可编辑/);
  });

  it("rejects an eventSeq that matches no message inside a turn", () => {
    const log = [...turnLog(0, 1), ...turnLog(8, 2)];
    expect(() =>
      editPlan(
        { action: "edit", sessionId, eventSeq: 7, blockIndex: 0, text: "x", cascade: "truncate" },
        closedTurns(log),
      ),
    ).toThrow(/不存在或不可编辑|不属于已落定回合/);
  });

  it("rejects editing an assistant message of an open turn", () => {
    const log = turnLog(0, 1, { closed: false });
    const assistantSeq = log.find((e) => e.type === "assistant/message")!.seq;
    expect(() =>
      editPlan(
        {
          action: "edit",
          sessionId,
          eventSeq: assistantSeq,
          blockIndex: 0,
          text: "x",
          cascade: "truncate",
        },
        closedTurns(log),
      ),
    ).toThrow(/未闭合轮次的助手消息不可编辑/);
  });
});

describe("retryPlan", () => {
  const sessionId = "s1" as never;

  it("queues all turn users for truncate retry (followups included)", () => {
    const log = turnLog(0, 1, {
      users: [
        { id: "u1", text: "first" },
        { id: "u2", text: "followup" },
      ],
    });
    const plan = retryPlan(
      { action: "retry", sessionId, turn: 1, cascade: "truncate" },
      closedTurns(log),
    );
    expect(plan.anchorSeq).toBe(0);
    expect(plan.queuedUsers).toHaveLength(2);
    expect(plan.version.effect).toMatchObject({ operation: "retry", targetTurn: 1 });
  });

  it("rejects retry of a turn without a user message", () => {
    const emptyTurn: SessionEvent[] = [
      { type: "turn/start", seq: 0 as never, time: 1, data: { turn: 1 } },
      {
        type: "turn/end",
        seq: 1 as never,
        time: 2,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ];
    expect(() =>
      retryPlan(
        { action: "retry", sessionId, turn: 1, cascade: "truncate" },
        closedTurns(emptyTurn),
      ),
    ).toThrow(/没有可重放的用户输入/);
  });
});

describe("rerollPlan", () => {
  const sessionId = "s1" as never;

  it("rerolls the last closed turn with text and queues its full input", () => {
    const log = [...twoTurnLog(), ...turnLog(12, 3, { users: [{ id: "u1", text: "third" }] })];
    const plan = rerollPlan({ action: "reroll", sessionId }, closedTurns(log));
    expect(plan.anchorSeq).toBe(12);
    expect(plan.version.effect).toMatchObject({ operation: "reroll", targetTurn: 3 });
    expect(plan.queuedUsers).toHaveLength(1);
  });

  it("rejects reroll when no closed turn has a textual reply", () => {
    const open = turnLog(0, 1, { closed: false });
    expect(() => rerollPlan({ action: "reroll", sessionId }, closedTurns(open))).toThrow(
      /没有可重生成的已落定助手回复/,
    );
  });
});

describe("precedingContentIndex", () => {
  const log = [...turnLog(0, 1), ...emptyTurn(6, 2), ...turnLog(8, 3)];

  it("skips empty turns between the target and the last content turn", () => {
    const turns = closedTurns(log);
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2, 3]);
    expect(precedingContentIndex(turns, 2)).toBe(0);
  });

  it("stops at a content turn and returns -1 before the first turn", () => {
    const turns = closedTurns(log);
    expect(precedingContentIndex(turns, 1)).toBe(0);
    expect(precedingContentIndex(turns, 0)).toBe(-1);
  });
});

describe("recallBoundary", () => {
  it("rewinds a later turn's first user to the previous turn/end", () => {
    const log = twoTurnLog();

    expect(recallBoundary(log, closedTurns(log), 7)).toBe(5);
  });

  it("clears the whole log for the first turn's first user (boundary -1)", () => {
    const log = oneTurnLog();
    expect(recallBoundary(log, closedTurns(log), 1)).toBe(-1);
  });

  it("rewinds a mid-turn followup to the message itself (exclusive drop)", () => {
    const log = turnLog(0, 1, {
      users: [
        { id: "u1", text: "first" },
        { id: "u2", text: "followup" },
      ],
    });
    const followupSeq = log.find(
      (event) => event.type === "user/message" && (event.data as { id: string }).id === "u2",
    )!.seq;
    expect(recallBoundary(log, closedTurns(log), followupSeq)).toBe(followupSeq);
  });

  it("rewinds a message before every turn to the message itself", () => {
    const outside = userMessage(0, "outside", "queued then stopped");
    const log = [outside, ...turnLog(1, 1)];
    expect(closedTurns(log)).toHaveLength(1);
    expect(recallBoundary(log, closedTurns(log), 0)).toBe(0);
  });

  it("rewinds a message between two turns to the message itself", () => {
    const outside = userMessage(6, "between", "queued between turns");
    const log = [...turnLog(0, 1), outside, ...turnLog(7, 2)];
    expect(recallBoundary(log, closedTurns(log), 6)).toBe(6);
  });

  it("rejects an event outside every turn that is not a user message", () => {
    const log = [assistantMessage(0, 1, 1, "orphan-assistant", "orphan"), ...turnLog(1, 1)];
    expect(() => recallBoundary(log, closedTurns(log), 0)).toThrow(/不属于已落定回合/);
  });

  it("rejects an unknown eventSeq", () => {
    const log = oneTurnLog();
    expect(() => recallBoundary(log, closedTurns(log), 99)).toThrow(/不属于已落定回合/);
  });

  it("rejects an eventSeq inside a turn that is not a turn user", () => {
    const log = oneTurnLog();

    expect(() => recallBoundary(log, closedTurns(log), 3)).toThrow(/不存在或不可撤回/);
  });
});
