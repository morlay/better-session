// 过程区展开状态：每轮最多记一条（轮次 + 回答步骤），重新展开覆盖旧步骤，收起即删除。
import { describe, expect, it } from "vitest";
import { createChatStore, storedTurnProcessEntry } from "../client/stores.ts";

function storeOf(
  ...opened: readonly [turn: number, answerStep: number][]
): ReturnType<ReturnType<typeof createChatStore>["create"]> {
  const instance = createChatStore().create();
  for (const [turn, answerStep] of opened) {
    instance.actions.setTurnProcessOpen(turn, answerStep, true);
  }
  return instance;
}

describe("setTurnProcessOpen", () => {
  it("starts with nothing expanded", () => {
    expect(storeOf().getSnapshot().turnProcesses).toEqual([]);
  });

  it("remembers one expanded turn", () => {
    expect(storeOf([2, 1]).getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 1 }]);
  });

  it("remembers several expanded turns", () => {
    expect(storeOf([1, 1], [3, 2]).getSnapshot().turnProcesses).toEqual([
      { turn: 1, answerStep: 1 },
      { turn: 3, answerStep: 2 },
    ]);
  });

  it("replaces the recorded step when the same turn is expanded again", () => {
    expect(storeOf([2, 1], [2, 3]).getSnapshot().turnProcesses).toEqual([
      { turn: 2, answerStep: 3 },
    ]);
  });

  it("forgets the turn when it is collapsed", () => {
    const instance = storeOf([2, 1], [3, 1]);
    instance.actions.setTurnProcessOpen(2, 1, false);

    expect(instance.getSnapshot().turnProcesses).toEqual([{ turn: 3, answerStep: 1 }]);
  });

  it("keeps the state when collapsing a turn that is not expanded", () => {
    const instance = storeOf([2, 1]);
    instance.actions.setTurnProcessOpen(9, 1, false);

    expect(instance.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 1 }]);
  });
});

describe("storedTurnProcessEntry", () => {
  it("reads back the entry of one turn", () => {
    const state = storeOf([2, 4]).getSnapshot();

    expect(storedTurnProcessEntry(state, 2)).toEqual({ turn: 2, answerStep: 4 });
    expect(storedTurnProcessEntry(state, 7)).toBeUndefined();
  });
});
