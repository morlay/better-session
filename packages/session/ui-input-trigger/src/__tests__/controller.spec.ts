// 客户端控制器的公共动词：track 驱动菜单 store、pick 把结果经 scoped 输入事件
// 交回输入层、键盘仲裁与空格/回车裁定按注册顺序轮询源。
// 装配：真实 cordis 根上下文作为 actx（事件分发是真的），源列表是我们自己的 roster。
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { InputTriggerController, type SourceRoster } from "../client/controller.ts";
import type {
  BeginCommandRequest,
  ClientSessionContext,
  CommandClaim,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  InsertReferenceRequest,
  InsertTextRequest,
  PickOutcome,
  ReferenceInsert,
  TriggerChar,
  TriggerGuard,
} from "../types.ts";

const sid = (key: string): SessionId => key as SessionId;
const plain: TriggerGuard = { tier: "plain" };
const tick = (): Promise<void> => Promise.resolve();

const claimOf = (token: string): CommandClaim => ({
  name: token.slice(1).trim(),
  token,
  submit: () => Promise.resolve({ kind: "success" }),
});

interface PendingFetch {
  readonly query: string;
  readonly signal: AbortSignal;
  readonly session: ClientSessionContext;
  resolve(items: readonly InputTriggerCandidate[]): void;
  reject(error: unknown): void;
}

/** 候选按调用方手工结清，便于观察 pending 状态与 abort。 */
function deferredSource(
  trigger: TriggerChar,
  name: string,
  over: Partial<InputTriggerSource> = {},
) {
  const pending: PendingFetch[] = [];
  const warm = vi.fn();
  const source: InputTriggerSource = {
    trigger,
    name,
    candidates: (session, req) =>
      new Promise<readonly InputTriggerCandidate[]>((resolve, reject) => {
        pending.push({ query: req.query, signal: req.signal, session, resolve, reject });
      }),
    onPick: () => undefined,
    warm,
    ...over,
  };
  return { source, pending, warm };
}

/** 候选立即就绪，记录每次拾取。 */
function readySource(
  trigger: TriggerChar,
  name: string,
  items: readonly InputTriggerCandidate[],
  outcome?: (pick: InputTriggerPick) => PickOutcome,
) {
  const picks: InputTriggerPick[] = [];
  const source: InputTriggerSource = {
    trigger,
    name,
    candidates: () => Promise.resolve(items),
    onPick: (pick) => {
      picks.push(pick);
      return outcome?.(pick);
    },
  };
  return { source, picks };
}

function enterSource(
  trigger: TriggerChar,
  name: string,
  matchEnter?: InputTriggerSource["matchEnter"],
): InputTriggerSource {
  return {
    trigger,
    name,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    ...(matchEnter === undefined ? {} : { matchEnter }),
  };
}

function bench(sources: InputTriggerSource[]) {
  const root = new Context();
  const roster: SourceRoster = {
    sources: (trigger) => sources.filter((source) => source.trigger === trigger),
    all: () => sources,
  };
  const controller = new InputTriggerController({ actx: root, sessionId: sid("a"), roster });
  return { root, controller, sources };
}

describe("控制器构造", () => {
  it("用会话投影预热每个源，没有 hook 的源被跳过", () => {
    const cmd = deferredSource("/", "command");
    const sub = deferredSource("@", "subagent");
    const bare: InputTriggerSource = {
      trigger: "/",
      name: "bare",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
    };
    bench([bare, cmd.source, sub.source]);
    expect(cmd.warm).toHaveBeenCalledExactlyOnceWith({ sessionId: sid("a") });
    expect(sub.warm).toHaveBeenCalledExactlyOnceWith({ sessionId: sid("a") });
  });
});

describe("track", () => {
  it("驱动 seed → pending → ready，并把首个候选设为高亮", async () => {
    const cmd = deferredSource("/", "command");
    const skill = deferredSource("/", "skill");
    const { controller } = bench([cmd.source, skill.source]);

    controller.track("/g", 2, plain, 1);
    expect(controller.menu.getSnapshot()).toMatchObject({
      open: true,
      groups: [
        { source: "command", status: "pending", items: [] },
        { source: "skill", status: "pending", items: [] },
      ],
    });

    cmd.pending[0]!.resolve([{ name: "goal" }]);
    await tick();
    expect(controller.menu.getSnapshot()).toMatchObject({
      groups: [
        { source: "command", status: "ready", items: [{ name: "goal" }] },
        { source: "skill", status: "pending", items: [] },
      ],
      highlight: { source: "command", index: 0 },
    });
  });

  it("把调用方的 draftRev 盖进 span，并把会话投影与查询交给候选请求", () => {
    const cmd = deferredSource("/", "command");
    const { controller } = bench([cmd.source]);
    controller.track("/g", 2, plain, 7);
    expect(controller.menu.getSnapshot().hit?.span).toEqual({ start: 0, end: 2, draftRev: 7 });
    expect(cmd.pending[0]!.query).toBe("g");
    expect(cmd.pending[0]!.session).toEqual({ sessionId: sid("a") });
  });

  it("查询细化开启新一代并中止旧取数，旧结果与旧候选按 stale-while-revalidate 处理", async () => {
    const cmd = deferredSource("/", "command");
    const { controller } = bench([cmd.source]);

    controller.track("/g", 2, plain, 1);
    cmd.pending[0]!.resolve([{ name: "goal" }]);
    await tick();

    controller.track("/go", 3, plain, 1);
    expect(controller.menu.getSnapshot().generation).toBe(2);
    expect(cmd.pending[0]!.signal.aborted).toBe(true);
    // 细化期间旧候选仍在屏上，但组已回到 pending。
    expect(controller.menu.getSnapshot().groups[0]).toEqual({
      source: "command",
      status: "pending",
      items: [{ name: "goal" }],
    });

    cmd.pending[1]!.resolve([{ name: "goat" }]);
    await tick();
    expect(controller.menu.getSnapshot().groups[0]).toEqual({
      source: "command",
      status: "ready",
      items: [{ name: "goat" }],
    });
  });

  it("同一 token 重复 track 不重新取数，但拾取用的是最新一版的 span", async () => {
    const picks: InputTriggerPick[] = [];
    const cmd = deferredSource("/", "command", {
      onPick: (pick) => {
        picks.push(pick);
        return undefined;
      },
    });
    const { controller } = bench([cmd.source]);
    controller.track("/g", 2, plain, 1);
    cmd.pending[0]!.resolve([{ name: "goal" }]);
    await tick();

    controller.track("/g x", 2, plain, 2);
    expect(cmd.pending).toHaveLength(1);
    expect(controller.menu.getSnapshot().generation).toBe(1);
    expect(controller.menu.getSnapshot().open).toBe(true);

    controller.pick("command", 0);
    expect(picks[0]!.span).toEqual({ start: 0, end: 2, draftRev: 2 });
  });

  it("没有活跃触发或该触发符没有源时关闭菜单并中止取数", () => {
    const cmd = deferredSource("/", "command");
    const { controller } = bench([cmd.source]);
    controller.track("/g", 2, plain, 1);
    controller.track("hello", 5, plain, 1);
    expect(controller.menu.getSnapshot().open).toBe(false);
    expect(cmd.pending[0]!.signal.aborted).toBe(true);

    const atTrigger = bench([readySource("/", "command", [{ name: "goal" }]).source]);
    atTrigger.controller.track("@w", 2, plain, 1);
    expect(atTrigger.controller.menu.getSnapshot().open).toBe(false);
  });

  it("切换触发符时按新触发符的名册重新播种组", () => {
    const { controller } = bench([
      deferredSource("/", "command").source,
      deferredSource("@", "subagent").source,
    ]);
    controller.track("/g", 2, plain, 1);
    expect(controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["command"]);
    controller.track("@w", 2, plain, 1);
    expect(controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["subagent"]);
    expect(controller.menu.getSnapshot().hit?.trigger).toBe("@");
  });

  it("所有源都结清成空候选时自动关闭", async () => {
    const cmd = deferredSource("/", "command");
    const skill = deferredSource("/", "skill");
    const { controller } = bench([cmd.source, skill.source]);
    controller.track("/zzz", 4, plain, 1);
    cmd.pending[0]!.resolve([]);
    await tick();
    expect(controller.menu.getSnapshot().open).toBe(true);
    skill.pending[0]!.resolve([]);
    await tick();
    expect(controller.menu.getSnapshot().open).toBe(false);
  });

  it("取数失败的源只记日志并静默移除自己的组", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cmd = deferredSource("/", "command");
      const skill = deferredSource("/", "skill");
      const { controller } = bench([cmd.source, skill.source]);
      controller.track("/g", 2, plain, 1);
      skill.pending[0]!.reject(new Error("boom"));
      cmd.pending[0]!.resolve([{ name: "goal" }]);
      await tick();
      expect(controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual([
        "command",
      ]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("skill"), expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("pick", () => {
  it("把候选面交给源，claim 结果经 scoped begin-command 事件执行并关闭菜单", async () => {
    const claim = claimOf("/goal ");
    const cmd = readySource("/", "command", [{ name: "goal" }, { name: "plan" }], () => ({
      claim,
    }));
    const { controller, root } = bench([cmd.source]);
    const begins: BeginCommandRequest[] = [];
    root.on("slash/input-begin-command", (req) => {
      begins.push(req);
      return true;
    });
    controller.track("/g", 2, plain, 3);
    await tick();

    controller.pick("command", 0);
    expect(cmd.picks[0]).toMatchObject({
      candidate: { name: "goal" },
      session: { sessionId: sid("a") },
      position: "leading",
      via: "menu",
      action: "pick",
      span: { start: 0, end: 2, draftRev: 3 },
    });
    expect(begins).toHaveLength(1);
    expect(begins[0]!.claim).toBe(claim);
    expect(controller.menu.getSnapshot().open).toBe(false);
  });

  it("insert 与 text 结果分别走 insert-reference / insert-text，continue 原样透传", async () => {
    const insert: ReferenceInsert = {
      source: "skill",
      ref: "/x",
      label: "x",
      clipboardText: "/x",
    };
    const insertBench = bench([
      readySource("/", "command", [{ name: "x" }], () => ({ insert })).source,
    ]);
    const inserts: InsertReferenceRequest[] = [];
    insertBench.root.on("slash/input-insert-reference", (req) => {
      inserts.push(req);
      return true;
    });
    insertBench.controller.track("/x", 2, plain, 1);
    await tick();
    insertBench.controller.pick("command", 0);
    expect(inserts).toEqual([{ reference: insert, span: { start: 0, end: 2, draftRev: 1 } }]);

    const textBench = bench([
      readySource("/", "command", [{ name: "src/" }], () => ({ text: "@src/", continue: true }))
        .source,
    ]);
    const texts: InsertTextRequest[] = [];
    textBench.root.on("slash/input-insert-text", (req) => {
      texts.push(req);
      return true;
    });
    textBench.controller.track("/s", 2, plain, 1);
    await tick();
    textBench.controller.pick("command", 0);
    expect(texts).toEqual([
      { text: "@src/", continue: true, span: { start: 0, end: 2, draftRev: 1 } },
    ]);
  });

  it("handled 结果只关菜单不分发；越界索引、未知源与已关闭菜单上的拾取是 no-op", async () => {
    const cmd = readySource("/", "command", [{ name: "goal" }], () => "handled");
    const { controller, root } = bench([cmd.source]);
    const begins: BeginCommandRequest[] = [];
    root.on("slash/input-begin-command", (req) => {
      begins.push(req);
      return true;
    });
    controller.track("/g", 2, plain, 1);
    await tick();

    controller.pick("command", 9);
    controller.pick("ghost", 0);
    expect(cmd.picks).toHaveLength(0);
    expect(controller.menu.getSnapshot().open).toBe(true);

    controller.pick("command", 0);
    expect(cmd.picks).toHaveLength(1);
    expect(begins).toHaveLength(0);
    expect(controller.menu.getSnapshot().open).toBe(false);

    controller.pick("command", 0);
    expect(cmd.picks).toHaveLength(1);
  });
});

describe("键盘仲裁", () => {
  it("上下移动高亮并消费按键，回车拾取高亮项", async () => {
    const cmd = readySource("/", "command", [{ name: "goal" }, { name: "plan" }]);
    const { controller } = bench([cmd.source]);
    controller.track("/g", 2, plain, 1);
    await tick();

    expect(controller.arbitrate("down", false)).toBe("consumed");
    expect(controller.menu.getSnapshot().highlight).toEqual({ source: "command", index: 1 });
    expect(controller.arbitrate("up", false)).toBe("consumed");
    expect(controller.menu.getSnapshot().highlight).toEqual({ source: "command", index: 0 });
    expect(controller.arbitrate("enter", false)).toBe("pick-highlighted");
    expect(cmd.picks[0]!.candidate.name).toBe("goal");
    expect(controller.menu.getSnapshot().open).toBe(false);
  });

  it("escape 关闭并消费；Tab 对 drill 行消费、对普通行拾取高亮", async () => {
    const drillable = readySource(
      "/",
      "command",
      [{ name: "src", drill: true }, { name: "plan" }],
      () => undefined,
    );
    const { controller } = bench([drillable.source]);
    controller.track("/s", 2, plain, 1);
    await tick();
    expect(controller.arbitrate("tab", false)).toBe("consumed");
    expect(drillable.picks[0]).toMatchObject({ action: "drill", candidate: { name: "src" } });

    controller.track("/s", 2, plain, 2);
    await tick();
    controller.arbitrate("down", false);
    expect(controller.arbitrate("tab", false)).toBe("pick-highlighted");
    expect(drillable.picks[1]).toMatchObject({ action: "pick", candidate: { name: "plan" } });

    controller.track("/s", 2, plain, 3);
    await tick();
    expect(controller.arbitrate("escape", false)).toBe("consumed");
    expect(controller.menu.getSnapshot().open).toBe(false);
  });

  it("IME 组字期间与关闭状态下所有按键都放行；细化期间的拾取键消费但不落结果", async () => {
    const picks: string[] = [];
    const cmd = deferredSource("/", "command", {
      onPick: (pick) => {
        picks.push(pick.candidate.name);
        return undefined;
      },
    });
    const { controller } = bench([cmd.source]);
    for (const key of ["up", "down", "enter", "escape", "tab"] as const) {
      expect(controller.arbitrate(key, true)).toBe("pass");
    }
    expect(controller.arbitrate("enter", false)).toBe("pass");

    controller.track("/g", 2, plain, 1);
    cmd.pending[0]!.resolve([{ name: "goal" }, { name: "plan" }]);
    await tick();
    controller.track("/go", 3, plain, 2);
    expect(controller.arbitrate("enter", false)).toBe("consumed");
    expect(controller.arbitrate("tab", false)).toBe("consumed");
    expect(picks).toHaveLength(0);
    expect(controller.menu.getSnapshot().open).toBe(true);

    cmd.pending[1]!.resolve([{ name: "goal" }]);
    await tick();
    expect(controller.arbitrate("enter", false)).toBe("pick-highlighted");
    expect(picks).toEqual(["goal"]);
  });
});

describe("空格裁定", () => {
  it("只对 leading token 按注册顺序轮询 matchSpace，首个非 undefined 答案胜出", () => {
    const calls: string[] = [];
    const claim = claimOf("/goal ");
    const first: InputTriggerSource = {
      trigger: "/",
      name: "first",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      matchSpace: (_session, token) => {
        calls.push(`first:${token}`);
        return undefined;
      },
    };
    const second: InputTriggerSource = {
      trigger: "/",
      name: "second",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      matchSpace: (_session, token) => {
        calls.push(`second:${token}`);
        return { claim };
      },
    };
    const third: InputTriggerSource = {
      trigger: "/",
      name: "third",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      matchSpace: () => ({ claim: claimOf("/other ") }),
    };
    const { controller, root } = bench([
      {
        trigger: "/",
        name: "nohook",
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
      },
      first,
      second,
      third,
    ]);
    const begins: BeginCommandRequest[] = [];
    root.on("slash/input-begin-command", (req) => {
      begins.push(req);
      return true;
    });

    controller.track("/goal", 5, plain, 1);
    expect(controller.onSpace()).toBe(true);
    expect(calls).toEqual(["first:/goal", "second:/goal"]);
    expect(begins).toHaveLength(1);
    expect(begins[0]!.span).toEqual({ start: 0, end: 5, draftRev: 1 });
  });

  it("输入层拒绝时返回 false；inline token 与无 hit 时不轮询", () => {
    const claim = claimOf("/goal ");
    const source: InputTriggerSource = {
      trigger: "/",
      name: "command",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      matchSpace: () => ({ claim }),
    };
    const declined = bench([source]);
    declined.root.on("slash/input-begin-command", () => undefined);
    declined.controller.track("/goal", 5, plain, 1);
    expect(declined.controller.onSpace()).toBe(false);

    const inline = bench([source]);
    const calls: string[] = [];
    inline.root.on("slash/input-begin-command", () => {
      calls.push("begin");
      return true;
    });
    inline.controller.track("say /goal", 9, plain, 1);
    expect(inline.controller.onSpace()).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("回车裁定", () => {
  it("按注册顺序轮询 matchEnter，跳过别的触发符，首个非 undefined 答案胜出", async () => {
    const calls: string[] = [];
    const claimed = claimOf("/goal ");
    const { controller } = bench([
      enterSource("@", "subagent", () => {
        calls.push("subagent");
        return Promise.resolve("handled");
      }),
      enterSource("/", "first", (_session, line) => {
        calls.push(`first:${line}`);
        return Promise.resolve(undefined);
      }),
      enterSource("/", "second", () => {
        calls.push("second");
        return Promise.resolve({ claim: claimed });
      }),
      enterSource("/", "third", () => {
        calls.push("third");
        return Promise.resolve("handled");
      }),
    ]);

    const outcome = await controller.adjudicate(
      "/goal make it fast",
      new AbortController().signal,
      {
        attachments: 0,
      },
    );
    expect(outcome).toMatchObject({ claim: { name: "goal", token: "/goal " } });
    expect(calls).toEqual(["first:/goal make it fast", "second"]);
  });

  it("没人认领时返回 undefined，源抛错则整体失败", async () => {
    const none = bench([enterSource("/", "command", () => Promise.resolve(undefined))]);
    await expect(
      none.controller.adjudicate("/xyz", new AbortController().signal, { attachments: 0 }),
    ).resolves.toBeUndefined();

    const rejecting = bench([
      enterSource("/", "command", () => Promise.reject(new Error("warmup"))),
    ]);
    await expect(
      rejecting.controller.adjudicate("/goal", new AbortController().signal, { attachments: 0 }),
    ).rejects.toThrow("warmup");
  });

  it("已中止的提交信号在轮询前就抛出", async () => {
    const hook = vi.fn(() => Promise.resolve(undefined));
    const { controller } = bench([enterSource("/", "command", hook)]);
    const abort = new AbortController();
    abort.abort(new Error("attempt released"));
    await expect(controller.adjudicate("/goal", abort.signal, { attachments: 0 })).rejects.toThrow(
      "attempt released",
    );
    expect(hook).not.toHaveBeenCalled();
  });
});
