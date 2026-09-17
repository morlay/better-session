// 指令认领与其结算：认领何时失效、提交成败如何回到用户可继续编辑的状态（纯逻辑）。
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

describe("SubmitMachine: 指令认领", () => {
  it("认领后的回车走指令提交，提交中再回车无效果", () => {
    const machine = new SubmitMachine();
    machine.dispatch({
      type: "claim",
      claim: claimOf("/goal ", { hint: "输入目标", attachments: true }),
    });
    expect(machine.state.phase).toBe("claimed");
    expect(machine.state.claim).toMatchObject({
      name: "goal",
      token: "/goal ",
      hint: "输入目标",
      attachments: true,
    });

    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );
    expect(machine.state.phase).toBe("submitting");
    expect(machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 再次" })).toEqual([]);
    void attempt;
  });

  it("草稿不再保留令牌时认领自行失效", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });

    machine.dispatch({ type: "draft-changed", draft: "/goa" });
    expect(machine.state.phase).toBe("plain");
    expect(machine.state.claim).toBeUndefined();
  });

  it("草稿仍以令牌开头（含去尾空格的形态）时认领保持", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });

    machine.dispatch({ type: "draft-changed", draft: "/goal 上线" });
    expect(machine.state.phase).toBe("claimed");

    machine.dispatch({ type: "draft-changed", draft: "/goal" });
    expect(machine.state.phase).toBe("claimed");
  });

  it("令牌后的参数按第一个空白切分", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );
    const effects = machine.dispatch({
      type: "adjudicated",
      attempt,
      outcome: { claim: claimOf("/goal ") },
    });
    const begin = effects[0];
    expect(begin?.type === "begin-submit" ? begin.args : null).toBe("上线");

    const bare = new SubmitMachine();
    const bareAttempt = attemptOf(bare.dispatch({ type: "enter", mode: "queue", draft: "/goal" }));
    const bareEffects = bare.dispatch({
      type: "adjudicated",
      attempt: bareAttempt,
      outcome: { claim: claimOf("/goal ") },
    });
    const bareBegin = bareEffects[0];
    expect(bareBegin?.type === "begin-submit" ? bareBegin.args : null).toBe("");
  });
});

describe("SubmitMachine: 指令提交结算", () => {
  it("指令成功后清空草稿并回到普通态", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );
    const effects = machine.dispatch({ type: "submit-settled", attempt, ok: true, draft: "" });

    expect(effects).toEqual([{ type: "commit-draft", retainSuffixOf: "/goal 上线" }]);
    expect(machine.state.phase).toBe("plain");
    expect(machine.state.claim).toBeUndefined();
  });

  it("指令成功带文案时额外提示", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );
    const effects = machine.dispatch({
      type: "submit-settled",
      attempt,
      ok: true,
      draft: "",
      outcome: { kind: "success", text: "已执行" },
    });

    expect(effects).toContainEqual({ type: "notice", level: "info", text: "已执行" });
  });

  it("指令失败且草稿未变时保留认领，用户可改参数重试", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );
    const effects = machine.dispatch({
      type: "submit-settled",
      attempt,
      ok: false,
      draft: "/goal 上线",
      message: "目标已存在",
    });

    expect(effects).toEqual([{ type: "notice", level: "error", text: "目标已存在" }]);
    expect(machine.state.phase).toBe("claimed");
  });

  it("指令失败且草稿已被改写时回到普通态", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );
    machine.dispatch({ type: "submit-settled", attempt, ok: false, draft: "改过的草稿" });

    expect(machine.state.phase).toBe("plain");
    expect(machine.state.claim).toBeUndefined();
  });

  it("附件被显式提交后清空草稿", () => {
    const machine = new SubmitMachine();
    expect(machine.dispatch({ type: "send-committed" })).toEqual([
      { type: "commit-draft", retainSuffixOf: null },
    ]);
  });

  it("非普通态下的附件提交不改动状态", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });

    expect(machine.dispatch({ type: "send-committed" })).toEqual([]);
    expect(machine.state.phase).toBe("claimed");
  });
});

describe("SubmitMachine: 释放", () => {
  it("释放中止在途提交并回到普通态", () => {
    const machine = new SubmitMachine();
    machine.dispatch({ type: "claim", claim: claimOf("/goal ") });
    const attempt = attemptOf(
      machine.dispatch({ type: "enter", mode: "queue", draft: "/goal 上线" }),
    );

    expect(machine.dispatch({ type: "release" })).toEqual([]);
    expect(attempt.signal.aborted).toBe(true);
    expect(machine.state.phase).toBe("plain");
    expect(machine.state.claim).toBeUndefined();
  });

  it("释放也中止 detached 提交", () => {
    const machine = new SubmitMachine();
    const attempt = attemptOf(machine.dispatch({ type: "enter", mode: "queue", draft: "x" }));
    machine.dispatch({ type: "release" });

    expect(attempt.signal.aborted).toBe(true);
  });
});
