/**
 * rewind 保留前缀平衡化（balanceRewindPrefix）的纯逻辑测试：真实 agent-loop
 * 顺序（step/start 在 user/message 之前）下 exclusive 截断残留的孤儿
 * step/start 被剔除，闭合轮次与配对 step 原样保留。
 */

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { balanceRewindPrefix } from "../index.ts";

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
    // 真实 agent-loop 顺序：turn/start → step/start → user/message → ...
    // rewind 到 user/message（exclusive）后，step/start 残留为孤儿。
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
    // step/start 与 step/end 都在保留区内：配对完整，不剔除。
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
    // 两个未闭合 step（step/end 都在 drop 区）：全部剔除。
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
    // 轮次开始标记保留（重放轮会开新的 turn/start）；只有孤儿 step/start 被剔除。
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
});
