// 控制器的源注册面：程序化启动器（toggleSource）、lexicon 热词表聚合与刷新、
// 面包屑头部与 drill 下钻、引用激活 / 序列化，以及销毁后的失效。
import { describe, expect, it, vi } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { InputTriggerController, type SourceRoster } from "../client/controller.ts";
import type { TriggerHit } from "../core/contract.ts";
import type {
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
  TriggerChar,
  TriggerGuard,
} from "../types.ts";
import { Context } from "@deepseek-ai/cordis";

const sid = (key: string): SessionId => key as SessionId;
const plain: TriggerGuard = { tier: "plain" };
const tick = (): Promise<void> => Promise.resolve();

interface PendingFetch {
  readonly signal: AbortSignal;
  resolve(items: readonly InputTriggerCandidate[]): void;
  reject(error: unknown): void;
}

function deferredSource(
  trigger: TriggerChar,
  name: string,
  over: Partial<InputTriggerSource> = {},
) {
  const pending: PendingFetch[] = [];
  const source: InputTriggerSource = {
    trigger,
    name,
    candidates: (_session, req) =>
      new Promise<readonly InputTriggerCandidate[]>((resolve, reject) => {
        pending.push({ signal: req.signal, resolve, reject });
      }),
    onPick: () => undefined,
    ...over,
  };
  return { source, pending };
}

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

function bench(sources: InputTriggerSource[]) {
  const root = new Context();
  const roster: SourceRoster = {
    sources: (trigger) => sources.filter((source) => source.trigger === trigger),
    all: () => sources,
  };
  const controller = new InputTriggerController({ actx: root, sessionId: sid("a"), roster });
  return { root, controller, sources };
}

/** 发布按查询路径分段的面包屑，并让 drill 拾取插入下一段。 */
function crumbSource() {
  const picks: InputTriggerPick[] = [];
  const source: InputTriggerSource = {
    trigger: "@",
    name: "reference",
    candidates: () => Promise.resolve([{ name: "src", drill: true, value: "src" }]),
    header: (_session, req) =>
      req.drilled && req.query.includes("/")
        ? req.query
            .split("/")
            .filter(Boolean)
            .map((label) => ({ label, value: label }))
        : undefined,
    onPick: (pick) => {
      picks.push(pick);
      return pick.action === "drill"
        ? { text: `@${String(pick.candidate.value)}/`, continue: true }
        : undefined;
    },
  };
  return { source, picks };
}

describe("程序化启动器", () => {
  const hit: TriggerHit = {
    trigger: "/",
    query: "",
    quoted: false,
    position: "leading",
    span: { start: 2, end: 5, draftRev: 7 },
  };

  it("只打开被点名的源，拾取后启动器复位并复用该 hit 的 span", async () => {
    const command = readySource("/", "command", [{ name: "goal" }]);
    const skill = readySource("/", "skill", [{ name: "review" }]);
    const { controller } = bench([command.source, skill.source]);

    controller.toggleSource("command", hit);
    await tick();
    expect(controller.launcher.getSnapshot()).toBe("command");
    expect(controller.menu.getSnapshot()).toMatchObject({
      open: true,
      groups: [{ source: "command", status: "ready", items: [{ name: "goal" }] }],
    });

    controller.pick("command", 0);
    expect(command.picks[0]!.span).toEqual({ start: 2, end: 5, draftRev: 7 });
    expect(skill.picks).toHaveLength(0);
    expect(controller.launcher.getSnapshot()).toBeNull();
  });

  it("再次 toggle 同一源即关闭；随后的输入跟踪回到全量 roster", async () => {
    const command = readySource("/", "command", [{ name: "goal" }]);
    const skill = readySource("/", "skill", [{ name: "review" }]);
    const { controller } = bench([command.source, skill.source]);

    controller.toggleSource("command", hit);
    controller.toggleSource("command", hit);
    expect(controller.menu.getSnapshot().open).toBe(false);
    expect(controller.launcher.getSnapshot()).toBeNull();

    controller.toggleSource("command", hit);
    controller.track("/g", 2, plain, 2);
    await tick();
    expect(controller.launcher.getSnapshot()).toBeNull();
    expect(controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual([
      "command",
      "skill",
    ]);
  });
});

describe("lexicon", () => {
  it("按触发符聚合各源的词表，未热与无 hook 的源跳过", () => {
    const skill: InputTriggerSource = {
      trigger: "/",
      name: "skill",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      lexicon: () => ["commit", "review"],
    };
    const prompt: InputTriggerSource = {
      trigger: "/",
      name: "prompt",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      lexicon: () => ["compact"],
    };
    const cold: InputTriggerSource = {
      trigger: "@",
      name: "subagent",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      lexicon: () => undefined,
    };
    const bare: InputTriggerSource = {
      trigger: "/",
      name: "bare",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
    };
    const { controller } = bench([bare, skill, prompt, cold]);
    const rolls = controller.lexicon.getSnapshot();
    expect([...rolls.keys()]).toEqual(["/"]);
    expect(rolls.get("/")).toEqual(["commit", "review", "compact"]);
  });

  it("词表通知会重新发布并刷新打开的菜单，销毁后解绑", async () => {
    let roll: readonly string[] | undefined = ["old"];
    let notify: (() => void) | undefined;
    const source: InputTriggerSource = {
      trigger: "/",
      name: "skill",
      candidates: () => Promise.resolve((roll ?? []).map((name) => ({ name }))),
      onPick: () => undefined,
      lexicon: () => roll,
      subscribeLexicon: (_session, listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const { controller } = bench([source]);
    expect(controller.lexicon.getSnapshot().get("/")).toEqual(["old"]);

    controller.track("/", 1, plain, 1);
    await tick();
    expect(controller.menu.getSnapshot().groups[0]?.items).toEqual([{ name: "old" }]);

    roll = ["commit"];
    notify?.();
    await tick();
    await tick();
    expect(controller.lexicon.getSnapshot().get("/")).toEqual(["commit"]);
    expect(controller.menu.getSnapshot().groups[0]?.items).toEqual([{ name: "commit" }]);

    controller.dispose();
    expect(notify).toBeUndefined();
  });

  it("后注册的源在活跃控制器里预热并入词表，移除后它自己的词表一起撤出", async () => {
    const command = readySource("/", "command", [{ name: "goal" }]);
    const { controller, sources } = bench([command.source]);
    controller.track("/g", 2, plain, 1);
    await tick();
    expect(controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["command"]);

    const warm = vi.fn();
    const late: InputTriggerSource = {
      trigger: "/",
      name: "late",
      candidates: () => Promise.resolve([{ name: "fresh" }]),
      onPick: () => undefined,
      warm,
      lexicon: () => ["fresh"],
    };
    sources.push(late);
    controller.sourceAdded(late);
    expect(warm).toHaveBeenCalledWith({ sessionId: sid("a") });
    expect(controller.lexicon.getSnapshot().get("/")).toEqual(["fresh"]);

    sources.splice(sources.indexOf(late), 1);
    controller.sourceRemoved(late);
    expect(controller.lexicon.getSnapshot().size).toBe(0);
    expect(controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual(["command"]);
  });
});

describe("头部与下钻", () => {
  it("drill 之后头部请求带 drilled，crumb 走同一 drill 路径，关闭菜单清空头部", async () => {
    const { source, picks } = crumbSource();
    const { controller, root } = bench([source]);
    const texts: string[] = [];
    root.on("slash/input-insert-text", (req) => {
      texts.push(req.text);
      return true;
    });

    controller.track("@sr", 3, plain, 1);
    await tick();
    expect(controller.headers.getSnapshot().size).toBe(0);

    controller.pick("reference", 0, "drill");
    expect(texts).toEqual(["@src/"]);
    expect(picks[0]).toMatchObject({ action: "drill", candidate: { name: "src" } });

    controller.track("@src/", 5, plain, 2);
    await tick();
    expect(controller.headers.getSnapshot().get("reference")).toEqual([
      { label: "src", value: "src" },
    ]);

    picks.length = 0;
    controller.pickCrumb("reference", 0);
    expect(picks[0]).toMatchObject({
      action: "drill",
      candidate: { name: "src", value: "src" },
    });
    expect(controller.headers.getSnapshot().size).toBe(0);
  });

  it("输入层拒绝下钻插入时 drilled 不生效，头部保持为空", async () => {
    const { source } = crumbSource();
    const { controller } = bench([source]);
    controller.track("@sr", 3, plain, 1);
    await tick();
    controller.pick("reference", 0, "drill");
    controller.track("@src/", 5, plain, 2);
    await tick();
    expect(controller.headers.getSnapshot().size).toBe(0);
  });
});

describe("引用激活与序列化", () => {
  it("openReference 按源名或热词表路由给属主源，成功后关闭菜单", async () => {
    const open = vi.fn(() => true);
    const lexicon = vi.fn(() => ["review"]);
    const skill: InputTriggerSource = {
      trigger: "/",
      name: "skill",
      candidates: () => Promise.resolve([{ name: "review" }]),
      onPick: () => undefined,
      lexicon,
      openReference: open,
    };
    const inert: InputTriggerSource = {
      trigger: "/",
      name: "inert",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      lexicon,
    };
    const { controller } = bench([inert, skill]);

    expect(controller.openReference(undefined, { ref: "/unknown" })).toBe(false);
    expect(controller.openReference("missing", { ref: "/review" })).toBe(false);

    controller.track("/r", 2, plain, 1);
    await tick();
    expect(controller.menu.getSnapshot().open).toBe(true);
    expect(controller.openReference(undefined, { ref: "/review" })).toBe(true);
    expect(open).toHaveBeenCalledWith({ sessionId: sid("a") }, { ref: "/review" });
    expect(controller.menu.getSnapshot().open).toBe(false);

    open.mockReturnValue(false);
    expect(controller.openReference("skill", { ref: "opaque" })).toBe(false);
  });

  it("serializeReference 转给属主源的 codec，没有 codec 时拒绝", async () => {
    const serialize = vi.fn((ref: string) => Promise.resolve(`<skill>${ref}</skill>`));
    const skill: InputTriggerSource = {
      trigger: "/",
      name: "skill",
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      codec: { clipboardText: (ref) => ref, serialize },
    };
    const { controller } = bench([skill]);
    await expect(
      controller.serializeReference("skill", "/review", new AbortController().signal),
    ).resolves.toBe("<skill>/review</skill>");
    expect(serialize).toHaveBeenCalledTimes(1);
    await expect(
      controller.serializeReference("ghost", "/x", new AbortController().signal),
    ).rejects.toThrow(/no serializer/);
  });
});

describe("销毁", () => {
  it("销毁后所有动词失效并中止取数", async () => {
    const picks: InputTriggerPick[] = [];
    const cmd = deferredSource("/", "command", {
      onPick: (pick) => {
        picks.push(pick);
        return undefined;
      },
    });
    const { controller } = bench([cmd.source]);
    controller.track("/g", 2, plain, 1);
    controller.dispose();

    expect(controller.menu.getSnapshot().open).toBe(false);
    expect(cmd.pending).toHaveLength(1);
    controller.track("/g", 2, plain, 1);
    expect(controller.menu.getSnapshot().open).toBe(false);
    expect(controller.arbitrate("down", false)).toBe("pass");
    expect(controller.onSpace()).toBe(false);
    controller.pick("command", 0);
    expect(controller.openReference("command", { ref: "/x" })).toBe(false);
    expect(picks).toHaveLength(0);
  });
});
