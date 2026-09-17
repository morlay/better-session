import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { balanceRewindPrefix } from "@morlay/session-branch";

function stepStart(seq: number, turn: number, step: number): SessionEvent {
  return { type: "step/start", seq, time: seq, data: { turn, step } } as SessionEvent;
}

function stepEnd(seq: number, turn: number, step: number): SessionEvent {
  return { type: "step/end", seq, time: seq, data: { turn, step } } as SessionEvent;
}

function turnStart(seq: number, turn: number): SessionEvent {
  return { type: "turn/start", seq, time: seq, data: { turn } } as SessionEvent;
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return {
    type: "turn/end",
    seq,
    time: seq,
    data: { turn, reason: { kind: "completed" } },
  } as SessionEvent;
}

describe("balanceRewindPrefix", () => {
  it("drops a trailing orphan step/start (real agent-loop order, user/message boundary)", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      {
        type: "user/message",
        seq: 2,
        time: 2,
        data: {
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      } as SessionEvent,
      stepEnd(3, 1, 1),
      turnEnd(4, 1),
      turnStart(5, 2),
      stepStart(6, 2, 1),
    ];
    const balanced = balanceRewindPrefix(prefix);
    expect(balanced.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(balanced.at(-1)?.type).toBe("turn/start");
  });

  it("keeps a closed turn intact (turn/end boundary)", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      stepEnd(2, 1, 1),
      turnEnd(3, 1),
    ];
    expect(balanceRewindPrefix(prefix).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("keeps a paired step whose step/end precedes the boundary", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      stepEnd(2, 1, 1),
      turnStart(3, 2),
      stepStart(4, 2, 1),
      stepEnd(5, 2, 1),
    ];
    expect(balanceRewindPrefix(prefix).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("drops multiple trailing orphan step/starts", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      stepEnd(2, 1, 1),
      turnEnd(3, 1),
      turnStart(4, 2),
      stepStart(5, 2, 1),
      stepStart(6, 2, 2),
    ];
    const balanced = balanceRewindPrefix(prefix);
    expect(balanced.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps the turn/start when the whole step tail is orphaned", () => {
    const prefix: SessionEvent[] = [turnStart(0, 1), stepStart(1, 1, 1)];
    const balanced = balanceRewindPrefix(prefix);
    expect(balanced.map((e) => e.seq)).toEqual([0]);
    expect(balanced[0]?.type).toBe("turn/start");
  });

  it("does not mutate the input", () => {
    const prefix: SessionEvent[] = [turnStart(0, 1), stepStart(1, 1, 1)];
    const snapshot = [...prefix];
    balanceRewindPrefix(prefix);
    expect(prefix).toEqual(snapshot);
  });

  it("returns an empty prefix for an empty log", () => {
    expect(balanceRewindPrefix([])).toEqual([]);
  });

  it("keeps a fully closed log untouched", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      stepEnd(2, 1, 1),
      turnEnd(3, 1),
    ];
    expect(balanceRewindPrefix(prefix)).toHaveLength(4);
  });

  it("drops the tail from an orphan step/end inside a closed turn (not only the tail after it)", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      stepEnd(2, 1, 1),
      turnEnd(3, 1),
      turnStart(4, 2),
      stepEnd(5, 2, 1),
      turnEnd(6, 2),
    ];
    const balanced = balanceRewindPrefix(prefix);
    expect(balanced.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(balanced.at(-1)?.type).toBe("turn/start");
  });

  it("drops consecutive orphan step/ends from the first one", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepEnd(1, 1, 1),
      stepEnd(2, 1, 1),
      turnEnd(3, 1),
    ];
    expect(balanceRewindPrefix(prefix).map((e) => e.seq)).toEqual([0]);
  });

  it("drops the whole log when its first event is an orphan step/end", () => {
    expect(balanceRewindPrefix([stepEnd(0, 1, 1), turnEnd(1, 1)]).map((e) => e.seq)).toEqual([]);
  });

  it("drops a step/end whose step number does not match the open step/start", () => {
    const prefix: SessionEvent[] = [turnStart(0, 1), stepStart(1, 1, 1), stepEnd(2, 1, 2)];
    expect(balanceRewindPrefix(prefix).map((e) => e.seq)).toEqual([0]);
  });

  it("drops a step/start that collides with an already open step/start", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      stepStart(2, 1, 2),
      turnEnd(3, 1),
    ];
    expect(balanceRewindPrefix(prefix).map((e) => e.seq)).toEqual([0]);
  });

  it("keeps a trailing unclosed step/start when the caller owns no following step (export / import)", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      {
        type: "user/message",
        seq: 2,
        time: 2,
        data: {
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      } as SessionEvent,
    ];
    expect(balanceRewindPrefix(prefix, { keepOpenTail: true }).map((e) => e.seq)).toEqual([
      0, 1, 2,
    ]);
  });

  it("still drops an unbalanced tail when the caller owns no following step (export / import)", () => {
    const prefix: SessionEvent[] = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      stepEnd(2, 1, 1),
      turnEnd(3, 1),
      turnStart(4, 2),
      stepEnd(5, 2, 1),
    ];
    expect(balanceRewindPrefix(prefix, { keepOpenTail: true }).map((e) => e.seq)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});
