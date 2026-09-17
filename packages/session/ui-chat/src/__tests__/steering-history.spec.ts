// steering 历史：next-step inbox 里被消费掉的那条排队消息，随后以 user/message
// 到达时仍是 steering（而不是新的用户轮次输入）；取消的消费不算数。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { SteeringHistory } from "../client/model/steering-history.ts";

function spliced(data: {
  target: "next-turn" | "next-step";
  start: number;
  removedCount?: number;
  inserted?: readonly string[];
  outcome?: "canceled";
}): SessionEvent {
  return {
    type: "agent/inbox/spliced",
    seq: 1,
    time: 1,
    data: {
      target: data.target,
      start: data.start,
      removedCount: data.removedCount ?? 0,
      inserted: (data.inserted ?? []).map((id) => ({ id })),
      ...(data.outcome === undefined ? {} : { outcome: data.outcome }),
    },
  } as unknown as SessionEvent;
}

function message(id: string, sourceKind: string): SessionEvent {
  return {
    type: "user/message",
    seq: 2,
    time: 2,
    data: {
      id,
      role: "user",
      content: [{ type: "text", text: "steer" }],
      source: { kind: sourceKind },
    },
  } as unknown as SessionEvent;
}

describe("SteeringHistory", () => {
  it("ignores unrelated events", () => {
    const history = new SteeringHistory();
    expect(
      history.apply({ type: "turn/start", seq: 0, time: 0, data: { turn: 1 } } as SessionEvent),
    ).toBe(false);
  });

  it("does not claim a message that is merely queued", () => {
    const history = new SteeringHistory();
    history.apply(spliced({ target: "next-step", start: 0, inserted: ["s1"] }));
    expect(history.apply(message("s1", "user"))).toBe(false);
  });

  it("claims the queued message that the next-step inbox consumed", () => {
    const history = new SteeringHistory();
    history.apply(spliced({ target: "next-step", start: 0, inserted: ["s1"] }));
    history.apply(spliced({ target: "next-step", start: 0, removedCount: 1 }));
    expect(history.apply(message("s1", "user"))).toBe(true);
  });

  it("claims only once", () => {
    const history = new SteeringHistory();
    history.apply(spliced({ target: "next-step", start: 0, inserted: ["s1"] }));
    history.apply(spliced({ target: "next-step", start: 0, removedCount: 1 }));
    expect(history.apply(message("s1", "user"))).toBe(true);
    expect(history.apply(message("s1", "user"))).toBe(false);
  });

  it("does not claim a canceled consumption", () => {
    const history = new SteeringHistory();
    history.apply(spliced({ target: "next-step", start: 0, inserted: ["s1"] }));
    history.apply(spliced({ target: "next-step", start: 0, removedCount: 1, outcome: "canceled" }));
    expect(history.apply(message("s1", "user"))).toBe(false);
  });

  it("does not claim a consumed next-turn entry", () => {
    const history = new SteeringHistory();
    history.apply(spliced({ target: "next-turn", start: 0, inserted: ["s1"] }));
    history.apply(spliced({ target: "next-turn", start: 0, removedCount: 1 }));
    expect(history.apply(message("s1", "user"))).toBe(false);
  });

  it("reports a non-user message as a non-steering even when its id was claimed", () => {
    const history = new SteeringHistory();
    history.apply(spliced({ target: "next-step", start: 0, inserted: ["s1"] }));
    history.apply(spliced({ target: "next-step", start: 0, removedCount: 1 }));
    expect(history.apply(message("s1", "plugin"))).toBe(false);
  });

  it("forgets every claim after a reset", () => {
    const history = new SteeringHistory();
    history.apply(spliced({ target: "next-step", start: 0, inserted: ["s1"] }));
    history.apply(spliced({ target: "next-step", start: 0, removedCount: 1 }));
    history.reset();
    expect(history.apply(message("s1", "user"))).toBe(false);
  });
});
