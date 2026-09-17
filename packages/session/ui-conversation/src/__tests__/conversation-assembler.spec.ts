// 事件 → 视图装配与位置索引：撤回 / 重试之后「历史如何呈现、定位到哪一轮」由它决定。
// 同时覆盖事件 / 视图登记表（注册即 effect，重复注册失败，撤销即移除）。
import { Context } from "@deepseek-ai/cordis";
import type {
  SessionAssistantSettlementEntry,
  SessionEventLikeEntry,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationNodeDefinition,
  ConversationStartMatch,
  ConversationTimelineSnapshot,
  ConversationViewDefinition,
  ConversationViewNode,
} from "../client/contract/conversation.ts";
import { ConversationNodeAssembler } from "../client/conversation/assembler.ts";
import { ConversationEventRegistry } from "../client/conversation/event-registry.ts";
import { ConversationViewRegistry } from "../client/conversation/view-registry.ts";

const TARGET = "chat";

function eventOf(type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent;
}

function entryOf(event: SessionEvent): SessionEventLikeEntry {
  return { type: "event", event };
}

function typeOf(event: { readonly type: string }): string {
  return event.type;
}

function textOf(event: { readonly data: unknown }): string {
  const data = event.data as { text?: string };
  return data.text ?? "";
}

interface UserState {
  readonly text: string;
  readonly turnsSeenBefore: number;
}

/** 一个 user 消息节点：start 时读前一个同类节点的状态，形成一条依赖边。 */
function userDefinition(
  options: { unstableKey?: boolean } = {},
): ConversationNodeDefinition<UserState> {
  return {
    kind: "user",
    target: TARGET,
    match: (event) =>
      event.type === "user/message" ? { id: `u${event.seq}`, role: "start" } : null,
    start: (context, match: ConversationStartMatch, reader) => ({
      text: textOf(match.event),
      turnsSeenBefore: reader.previous<UserState>("user") === undefined ? 0 : 1,
    }),
    update: (context) => context.state,
    buildViewNode: (context) => ({
      key: options.unstableKey === true ? "unstable" : context.key,
      kind: "user",
      id: context.id,
      target: TARGET,
      data: context.state,
    }),
  };
}

interface Snapshot {
  readonly nodes: readonly ConversationViewNode[];
  readonly timeline: ConversationTimelineSnapshot;
}

function viewBench(options: { active?: (snapshot: Snapshot) => boolean } = {}) {
  const replaces: Snapshot[] = [];
  const upserts: (readonly ConversationViewNode[])[] = [];
  let snapshot: Snapshot = { nodes: [], timeline: { turnOrder: [], turns: new Map() } };
  const definition: ConversationViewDefinition = {
    target: TARGET,
    create: () => ({
      empty: { nodes: [], timeline: { turnOrder: [], turns: new Map() } },
      replace: (input) => {
        replaces.push(input);
        snapshot = { nodes: input.nodes, timeline: input.timeline };
        return snapshot;
      },
      apply: (input) => {
        upserts.push(input.upserts);
        const byKey = new Map(snapshot.nodes.map((node) => [node.key, node]));
        for (const node of input.upserts) byKey.set(node.key, node);
        snapshot = { nodes: [...byKey.values()], timeline: input.timeline };
        return snapshot;
      },
    }),
    ...(options.active === undefined ? {} : { isActive: options.active }),
  };
  return {
    definition,
    replaces,
    upserts,
    current: () => snapshot,
    texts: () => snapshot.nodes.map((node) => (node.data as UserState).text),
  };
}

function assemblerOf(
  definitions: readonly ConversationNodeDefinition[],
  fallback: ConversationNodeDefinition | undefined,
  view: ConversationViewDefinition,
): ConversationNodeAssembler {
  return new ConversationNodeAssembler(
    {
      entries: () => definitions,
      fallbackEntry: () => fallback,
    },
    { entries: () => [view] },
  );
}

describe("ConversationNodeAssembler: 窗口装配", () => {
  it("替换窗口后激活目标才产出视图，且只替换一次", () => {
    const view = viewBench();
    const assembler = assemblerOf([userDefinition()], undefined, view.definition);
    const publication = assembler.replaceWindow(
      [entryOf(eventOf("user/message", 1, { turn: 0, text: "第一条" }))],
      false,
    );

    expect(publication).toBe("immediate");
    expect(view.replaces).toHaveLength(0);

    expect(assembler.activateTarget(TARGET)).toBe(true);
    expect(view.replaces).toHaveLength(1);
    expect(view.texts()).toEqual(["第一条"]);
    expect(assembler.flush()).toBe(false);
  });

  it("追加事件走增量更新，视图快照累积两个节点", () => {
    const view = viewBench();
    const assembler = assemblerOf([userDefinition()], undefined, view.definition);
    assembler.replaceWindow(
      [entryOf(eventOf("user/message", 1, { turn: 0, text: "第一条" }))],
      false,
    );
    assembler.activateTarget(TARGET);

    expect(assembler.append(entryOf(eventOf("user/message", 2, { turn: 0, text: "第二条" })))).toBe(
      "immediate",
    );
    assembler.flush();

    expect(view.upserts.at(-1)).toHaveLength(1);
    expect(view.texts()).toEqual(["第一条", "第二条"]);
  });

  it("重复的窗口条目不会二次装配", () => {
    const view = viewBench();
    const assembler = assemblerOf([userDefinition()], undefined, view.definition);
    const record = entryOf(eventOf("user/message", 1, { turn: 0, text: "第一条" }));
    assembler.replaceWindow([record], false);
    assembler.activateTarget(TARGET);

    expect(assembler.append(record)).toBe("none");
    assembler.flush();
    expect(view.texts()).toEqual(["第一条"]);
  });

  it("未声明目标的定义不进视图，活性目标由视图自述决定", () => {
    const inactive = viewBench({ active: () => false });
    const active = viewBench({ active: () => true });
    const assembler = assemblerOf([userDefinition()], undefined, inactive.definition);
    assembler.replaceWindow(
      [entryOf(eventOf("user/message", 1, { turn: 0, text: "第一条" }))],
      false,
    );
    assembler.activateTarget(TARGET);

    expect(assembler.activityTargets().size).toBe(0);

    const other = assemblerOf([userDefinition()], undefined, active.definition);
    other.replaceWindow([entryOf(eventOf("user/message", 1, { turn: 0, text: "第一条" }))], false);
    other.activateTarget(TARGET);
    expect([...other.activityTargets()]).toEqual([TARGET]);
  });

  it("视图节点 key 不稳定时装配失败", () => {
    const view = viewBench();
    const assembler = assemblerOf(
      [userDefinition({ unstableKey: true })],
      undefined,
      view.definition,
    );
    assembler.replaceWindow([entryOf(eventOf("user/message", 1, { turn: 0, text: "x" }))], false);

    expect(() => assembler.activateTarget(TARGET)).toThrow(/unstable key/u);
  });
});

describe("ConversationNodeAssembler: 依赖与回放", () => {
  it("后插入的同类事件让依赖重放，先前的节点看到更新后的前驱", () => {
    const view = viewBench();
    const assembler = assemblerOf([userDefinition()], undefined, view.definition);
    const later = entryOf(eventOf("user/message", 5, { turn: 0, text: "第二条" }));
    assembler.replaceWindow([later], false);
    assembler.activateTarget(TARGET);
    expect((assembler.snapshot(TARGET) as Snapshot).nodes[0]?.data).toMatchObject({
      text: "第二条",
      turnsSeenBefore: 0,
    });

    assembler.prepend([entryOf(eventOf("user/message", 1, { turn: 0, text: "第一条" }))], false);
    assembler.flush();

    const nodes = (assembler.snapshot(TARGET) as Snapshot).nodes;
    expect(view.texts()).toEqual(expect.arrayContaining(["第一条", "第二条"]));
    expect(
      Object.fromEntries(
        nodes.map((node) => {
          const data = node.data as UserState;
          return [data.text, data.turnsSeenBefore];
        }),
      ),
    ).toEqual({ 第一条: 0, 第二条: 1 });
  });
});

describe("ConversationNodeAssembler: 未匹配事件的兜底定义", () => {
  it("没有专门定义认领的事件落到兜底定义并出现在同一视图里", () => {
    const view = viewBench();
    const fallback: ConversationNodeDefinition = {
      kind: "unknown",
      target: TARGET,
      match: (event) =>
        typeOf(event) === "notice" ? { id: `n${event.seq}`, role: "start" } : null,
      start: (context, match) => ({ text: textOf(match.event) }),
      update: (context) => context.state,
      buildViewNode: (context) => ({
        key: context.key,
        kind: "unknown",
        id: context.id,
        target: TARGET,
        data: context.state,
      }),
    };
    const assembler = assemblerOf([userDefinition()], fallback, view.definition);
    assembler.replaceWindow(
      [
        entryOf(eventOf("user/message", 1, { turn: 0, text: "用户" })),
        entryOf(eventOf("notice", 2, { turn: null, text: "提示" })),
      ],
      false,
    );
    assembler.activateTarget(TARGET);

    const nodes = (assembler.snapshot(TARGET) as Snapshot).nodes;
    expect(nodes.map((node) => node.kind).sort()).toEqual(["unknown", "user"]);
  });
});

describe("ConversationNodeAssembler: 助手流式行结算", () => {
  it("结算后流式行从视图退役，定稿消息取而代之", () => {
    const view = viewBench();
    const attemptId = "attempt-1";
    const assistant: ConversationNodeDefinition<{ text: string }> = {
      kind: "assistant",
      target: TARGET,
      match: (event) => {
        if (event.type === "assistant/attempt")
          return { id: `turn-${event.data.turn as number}`, role: "start" };
        if (event.type === "assistant/live-chunk" || event.type === "assistant/message")
          return { id: `turn-${event.data.turn as number}`, role: "update" };
        return null;
      },
      start: () => ({ text: "" }),
      update: (context, match) => ({
        text: match.event.type === "assistant/message" ? "定稿" : `${context.state.text}流式`,
      }),
      buildViewNode: (context) => ({
        key: context.key,
        kind: "assistant",
        id: context.id,
        target: TARGET,
        data: context.state,
      }),
    };
    const assembler = assemblerOf([assistant], undefined, view.definition);
    assembler.replaceWindow(
      [
        entryOf(eventOf("assistant/attempt", 1, { turn: 0, step: 0 })),
        {
          type: "transient",
          event: eventOf("assistant/live-chunk", 2, { turn: 0, step: 0, attemptId }),
        },
        {
          type: "transient",
          event: eventOf("assistant/live-chunk", 3, { turn: 0, step: 0, attemptId }),
        },
      ] as SessionEventLikeEntry[],
      false,
    );
    assembler.activateTarget(TARGET);
    expect((assembler.snapshot(TARGET) as Snapshot).nodes[0]?.data).toEqual({ text: "流式流式" });

    assembler.settleAssistant(
      attemptId as never,
      {
        type: "event",
        event: eventOf("assistant/message", 4, { turn: 0, step: 0, text: "定稿" }),
      } as unknown as SessionAssistantSettlementEntry,
    );
    assembler.flush();

    const last = view.upserts.at(-1) ?? [];
    expect(last.map((node) => node.id)).toEqual(["turn-0"]);
    expect(last[0]?.data).toEqual({ text: "定稿" });
  });
});

describe("事件与视图登记表", () => {
  function registryBench() {
    const ctx = new Context();
    return {
      ctx,
      events: new ConversationEventRegistry(ctx),
      views: new ConversationViewRegistry(ctx),
    };
  }

  it("注册后出现在条目里，撤销后移除", async () => {
    const { events } = registryBench();
    const listener = vi.fn();
    events.subscribe(listener);
    const definition = userDefinition();

    const dispose = events.register(definition);
    expect(events.entries()).toEqual([definition]);
    expect(listener).toHaveBeenCalledTimes(1);

    dispose();
    await Promise.resolve();
    expect(events.entries()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("同一类型重复注册失败", () => {
    const { events } = registryBench();
    events.register(userDefinition());

    expect(() => events.register(userDefinition())).toThrow(/already registered/u);
  });

  it("定义必须同时声明目标与视图节点构造函数", () => {
    const { events } = registryBench();
    const broken: ConversationNodeDefinition = {
      kind: "broken",
      target: TARGET,
      match: () => null,
      start: (context, match) => ({ text: textOf(match.event) }),
      update: (context) => context.state,
    };

    expect(() => events.register(broken)).toThrow(/together/u);
  });

  it("兜底定义只能有一个，撤销后可以再注册", async () => {
    const { events } = registryBench();
    const first: ConversationNodeDefinition = {
      kind: "unknown",
      target: TARGET,
      match: () => null,
      start: (context, match) => ({ text: textOf(match.event) }),
      update: (context) => context.state,
      buildViewNode: (context) => ({
        key: context.key,
        kind: "unknown",
        id: context.id,
        target: TARGET,
        data: context.state,
      }),
    };
    const dispose = events.registerFallback(first);
    expect(events.fallbackEntry()).toBe(first);
    expect(() => events.registerFallback({ ...first, kind: "other" })).toThrow(
      /already registered/u,
    );

    dispose();
    await Promise.resolve();
    expect(events.fallbackEntry()).toBeUndefined();
  });

  it("视图目标重复注册失败，撤销后目标释放", async () => {
    const { views } = registryBench();
    const view = viewBench().definition;
    const dispose = views.register(view);
    expect(views.entries()).toEqual([view]);
    expect(() => views.register(view)).toThrow(/already registered/u);

    dispose();
    await Promise.resolve();
    expect(views.entries()).toEqual([]);
    expect(() => views.register(view)).not.toThrow();
  });
});
