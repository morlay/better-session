import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  closedTurns,
  editableMessages,
  editPlan,
  retryPlan,
  rerollPlan,
  retryableTurns,
} from "@morlay/ui-conversation-message-actions/plan";
import { turnLog, twoTurnLog } from "@morlay/ui-conversation-message-actions/testing";

// —— 底层纯函数（plan.ts）全矩阵：不落库、无 IO，直接断言计划输出。 ——

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
    expect(turn?.user?.seq).toBe(2); // 轮首输入
    expect(turn?.users).toHaveLength(2);
  });

  it("ignores non-user-sourced messages", () => {
    // open turn 中先出现一条 source.kind !== "user" 的 user/message，
    // 再出现真正的用户输入——只有后者进入 users。
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
    expect(turn?.users).toHaveLength(1); // 只记录真用户输入
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
      { action: "edit", sessionId, eventSeq: 2, blockIndex: 0, text: "edited q", cascade: "truncate" },
      closedTurns(log),
    );
    expect(plan.anchorSeq).toBe(0);
    expect(plan.rewindBoundary).toBeUndefined(); // 整轮截断语义
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
    // followup user seq：base 0 + turn/start(0) + step/start(1) + u1(2) + a1(3)
    // + step/end(4) + step/start(5) + u2(6)
    const followupSeq = log.find((e) => e.type === "user/message" && (e.data as { id: string }).id === "u2")!.seq;
    const plan = editPlan(
      { action: "edit", sessionId, eventSeq: followupSeq, blockIndex: 0, text: "edited f", cascade: "truncate" },
      closedTurns(log),
    );
    expect(plan.rewindBoundary).toBe(followupSeq); // 消息级 rewind
    expect(plan.queuedUsers).toHaveLength(1); // 只有编辑版 followup（无后续同轮输入）
    expect((plan.queuedUsers[0] as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "edited f",
    );
  });

  it("edits the first user of an open turn → message-level rewind", () => {
    const log = turnLog(0, 1, { closed: false });
    const plan = editPlan(
      { action: "edit", sessionId, eventSeq: 2, blockIndex: 0, text: "edited q", cascade: "truncate" },
      closedTurns(log),
    );
    expect(plan.rewindBoundary).toBe(2);
  });

  it("preserve cascade queues downstream turn inputs after the edited one", () => {
    const log = [...twoTurnLog(), ...turnLog(12, 3)];
    const plan = editPlan(
      { action: "edit", sessionId, eventSeq: 1, blockIndex: 0, text: "q1 edited", cascade: "preserve" },
      closedTurns(log),
    );
    // 轮 1 整轮截断重放：q1 + 轮 2 q2 + 轮 3 q3
    expect(plan.queuedUsers).toHaveLength(3);
  });

  it("edits a closed-turn assistant response → manualTurn with replacement", () => {
    const log = turnLog(0, 1);
    const plan = editPlan(
      { action: "edit", sessionId, eventSeq: 3, blockIndex: 0, text: "answer edited", cascade: "truncate" },
      closedTurns(log),
    );
    expect(plan.manualTurn).toBeDefined();
    expect(plan.manualTurn?.turn).toBe(1);
    const assistant = plan.manualTurn!.assistant;
    expect((assistant.content[0] as { text: string }).text).toBe("answer edited");
  });

  it("rejects an eventSeq beyond the last turn (no matching turn)", () => {
    // 空日志：无任何轮 → turn 定位失败。
    expect(() =>
      editPlan(
        { action: "edit", sessionId, eventSeq: 0, blockIndex: 0, text: "x", cascade: "truncate" },
        closedTurns([]),
      ),
    ).toThrow(/不属于已落定回合/);
  });

  it("rejects an unknown eventSeq inside an open turn", () => {
    // 未闭合轮（startSeq 0，无 endSeq）中 99 落在轮范围，但轮内无此消息。
    const log = turnLog(0, 1, { closed: false });
    expect(() =>
      editPlan(
        { action: "edit", sessionId, eventSeq: 99, blockIndex: 0, text: "x", cascade: "truncate" },
        closedTurns(log),
      ),
    ).toThrow(/不存在或不可编辑/);
  });

  it("rejects an eventSeq that matches no message inside a turn", () => {
    // 闭合轮 turn/start(0)…turn/end(7)；seq 7 = turn/end 不是可编辑消息，
    // 且 > turn.startSeq、== turn.endSeq 不满足（< endSeq）→ 定位到下一轮失败。
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
        { action: "edit", sessionId, eventSeq: assistantSeq, blockIndex: 0, text: "x", cascade: "truncate" },
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
    // 只有 turn/start + turn/end 的轮
    const emptyTurn: SessionEvent[] = [
      { type: "turn/start", seq: 0 as never, time: 1, data: { turn: 1 } },
      { type: "turn/end", seq: 1 as never, time: 2, data: { turn: 1, reason: { kind: "completed" } } },
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

