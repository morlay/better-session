// 输入状态机是 composer 的闭环心脏：认领、裁定、提交、队列回退都在这里决定
// （纯逻辑，无 DOM）。
import { describe, expect, it } from "vitest";
import type {
  CommandClaim,
  InputEffect,
  SubmitAttempt,
  SubmitOutcome,
} from "../client/contract/input.ts";
import { SubmitMachine } from "../client/input/machine.ts";

function claimOf(token: string, overrides: Partial<CommandClaim> = {}): CommandClaim {
  return {
    name: "goal",
    token,
    submit: async (): Promise<SubmitOutcome> => ({ kind: "success" }),
    ...overrides,
  };
}

function attemptOf(effects: readonly InputEffect[]): SubmitAttempt {
  const first = effects[0];
  if (first === undefined || !("attempt" in first)) throw new Error("no attempt effect");
  return first.attempt;
}

describe("SubmitMachine: 普通文本提交", () => {
  it("普通文本的回车走一次 detached 提交：交给 sink 并清空草稿", () => {
    const machine = new SubmitMachine();
    const effects = machine.dispatch({ type: "enter", mode: "queue", draft: "hello" });

    expect(effects.map((effect) => effect.type)).toEqual(["default-sink", "commit-draft"]);
    expect(attemptOf(effects)).toMatchObject({ seq: 1, draftSnapshot: "hello", mode: "queue" });
    expect(effects[1]).toEqual({ type: "commit-draft", retainSuffixOf: "hello" });
    expect(machine.state.phase).toBe("plain");
  });

  it("空白草稿的回车不产生任何效果", () => {
    const machine = new SubmitMachine();
    expect(machine.dispatch({ type: "enter", mode: "queue", draft: "   " })).toEqual([]);
    expect(machine.state.phase).toBe("plain");
  });

  it("detached 提交后草稿仍可再次提交，各次都拿到自己的序号", () => {
    const machine = new SubmitMachine();
    const first = attemptOf(machine.dispatch({ type: "enter", mode: "queue", draft: "一" }));
    const second = attemptOf(machine.dispatch({ type: "enter", mode: "steer", draft: "二" }));

    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(second.mode).toBe("steer");
  });

  it("sink 失败时给出错误提示，成功且无附加文案时保持安静", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(machine.dispatch({ type: "enter", mode: "queue", draft: "x" }));

    expect(
      machine.dispatch({ type: "sink-settled", attempt, ok: false, message: "网络错误" }),
    ).toEqual([{ type: "notice", level: "error", text: "网络错误" }]);
    expect(machine.dispatch({ type: "sink-settled", attempt, ok: true })).toEqual([]);
  });

  it("同一 attempt 的 settle 只结算一次", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(machine.dispatch({ type: "enter", mode: "queue", draft: "x" }));
    machine.dispatch({
      type: "sink-settled",
      attempt,
      ok: true,
      outcome: { kind: "success", text: "好" },
    });

    expect(
      machine.dispatch({
        type: "sink-settled",
        attempt,
        ok: true,
        outcome: { kind: "success", text: "好" },
      }),
    ).toEqual([]);
  });
});

describe("SubmitMachine: 斜杠行裁定", () => {
  it("斜杠开头的草稿先进入裁定，不直接提交", () => {
    const machine = new SubmitMachine();
    const effects = machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" });

    expect(effects.map((effect) => effect.type)).toEqual(["adjudicate"]);
    expect(machine.state.phase).toBe("adjudicating");
  });

  it("裁定出指令时转入提交，参数是 token 之后的剩余文本", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );
    const effects = machine.dispatch({
      type: "adjudicated",
      attempt,
      outcome: { claim: claimOf("/goal ") },
    });

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "begin-submit", attempt, args: "上线" });
    expect(machine.state.phase).toBe("submitting");
    expect(machine.state.claim).toMatchObject({ name: "goal", token: "/goal " });
  });

  it("裁定未命中时整行落回 sink", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/xyz 干活" }),
    );
    const effects = machine.dispatch({ type: "adjudicated", attempt, outcome: undefined });

    expect(effects.map((effect) => effect.type)).toEqual(["default-sink", "commit-draft"]);
    expect(machine.state.phase).toBe("plain");
  });

  it("裁定说已处理时不提交也不提示", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/compact" }),
    );

    expect(machine.dispatch({ type: "adjudicated", attempt, outcome: "handled" })).toEqual([]);
    expect(machine.state.phase).toBe("plain");
  });

  it("裁定过程失败时提示并把草稿留给用户", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/plan 上线" }),
    );
    const effects = machine.dispatch({
      type: "adjudication-failed",
      attempt,
      message: "目录预热失败",
    });

    expect(effects).toEqual([{ type: "notice", level: "error", text: "目录预热失败" }]);
    expect(machine.state.phase).toBe("plain");
  });

  it("被释放中止的 attempt 的裁定结果被忽略", () => {
    const machine = new SubmitMachine();
    const stale = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 第一件" }),
    );
    machine.dispatch({ type: "release" });
    machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 第二件" });

    expect(
      machine.dispatch({
        type: "adjudicated",
        attempt: stale,
        outcome: { claim: claimOf("/goal ") },
      }),
    ).toEqual([]);
    expect(machine.state.phase).toBe("adjudicating");
  });
});
