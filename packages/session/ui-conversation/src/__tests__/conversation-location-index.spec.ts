// 撤回 / 重试之后历史要仍然「可定位」：事件到轮次 / 步骤的归属、时间线状态与位置数据
// 全部由位置索引决定（纯逻辑）。
import type {
  AssistantLiveChunkEvent,
  SessionEventLikeEntry,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it, vi } from "vitest";
import type { ConversationLocationData } from "../client/contract/conversation.ts";
import { ConversationLocationIndex } from "../client/conversation/location-index.ts";

function eventOf(type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent;
}

function entryOf(event: SessionEvent): SessionEventLikeEntry {
  return { type: "event", event };
}

function chunkOf(seq: number, turn: number, step: number): AssistantLiveChunkEvent {
  return {
    type: "assistant/live-chunk",
    seq,
    time: seq,
    data: { attemptId: `a${seq}`, turn, step, chunk: { kind: "text", text: "…" } },
  } as unknown as AssistantLiveChunkEvent;
}

/** 一轮两步 + 一个会话级事件 + 一次助手结算事件的完整日志。 */
function seeded(): {
  index: ConversationLocationIndex;
  events: Record<string, SessionEvent>;
} {
  const events: Record<string, SessionEvent> = {
    turnStart: eventOf("turn/start", 1, { turn: 0 }),
    stepStart0: eventOf("step/start", 2, { turn: 0, step: 0 }),
    userMessage: eventOf("user/message", 3, { turn: 0, step: 0 }),
    stepEnd0: eventOf("step/end", 4, { turn: 0, step: 0 }),
    stepStart1: eventOf("step/start", 5, { turn: 0, step: 1 }),
    assistant: eventOf("assistant/message", 6, { turn: 0, step: 1 }),
    turnEnd: eventOf("turn/end", 7, { turn: 0 }),
    sessionNotice: eventOf("notice", 8, { turn: null }),
  };
  const index = new ConversationLocationIndex();
  index.rebuild(Object.values(events).map((event) => entryOf(event)));
  return { index, events };
}

describe("ConversationLocationIndex: 事件归属", () => {
  it("轮次与步骤边界把其间的事件归到该轮该步", () => {
    const { index, events } = seeded();
    const userMessage = events.userMessage as SessionEvent;
    const assistant = events.assistant as SessionEvent;

    expect(index.locationOf(userMessage)).toMatchObject({ kind: "step" });
    const located = index.locationOf(userMessage);
    expect(located.kind === "step" ? located.step.step : null).toBe(0);
    expect(index.locationOf(assistant)).toMatchObject({ kind: "step" });
    const assistantLocation = index.locationOf(assistant);
    expect(assistantLocation.kind === "step" ? assistantLocation.step.step : null).toBe(1);
  });

  it("未闭合的步骤是运行中的状态，闭合后步骤与轮次都关闭", () => {
    const events = {
      turnStart: eventOf("turn/start", 1, { turn: 0 }),
      stepStart: eventOf("step/start", 2, { turn: 0, step: 0 }),
      user: eventOf("user/message", 3, { turn: 0, step: 0 }),
    };
    const index = new ConversationLocationIndex();
    index.rebuild(Object.values(events).map((event) => entryOf(event as SessionEvent)));

    const timeline = index.snapshot();
    expect(timeline.turnOrder).toEqual([0]);
    expect(timeline.turns.get(0)?.status).toBe("open");
    expect(timeline.turns.get(0)?.steps.map((step) => step.status)).toEqual(["open"]);
  });

  it("轮次闭合后仍保留未闭合的步骤状态", () => {
    const { index } = seeded();
    const turn = index.snapshot().turns.get(0);

    expect(turn?.status).toBe("closed");
    expect(turn?.steps.map((step) => step.status)).toEqual(["closed", "open"]);
  });

  it("会话级事件（无轮次字段）不属于任何轮次", () => {
    const { index, events } = seeded();
    expect(index.locationOf(events.sessionNotice as SessionEvent)).toEqual({ kind: "session" });
  });

  it("只有轮次归属的边界事件归到轮次而不是步骤", () => {
    const { index, events } = seeded();
    expect(index.locationOf(events.turnEnd as SessionEvent)).toMatchObject({ kind: "turn" });
    expect(index.locationOf(events.turnStart as SessionEvent)).toMatchObject({ kind: "turn" });
  });

  it("多个轮次按开始顺序进入时间线", () => {
    const index = new ConversationLocationIndex();
    index.rebuild(
      [
        eventOf("turn/start", 1, { turn: 0 }),
        eventOf("turn/end", 2, { turn: 0 }),
        eventOf("turn/start", 3, { turn: 1 }),
      ].map((event) => entryOf(event)),
    );

    expect(index.snapshot().turnOrder).toEqual([0, 1]);
    expect(index.snapshot().turns.get(1)?.status).toBe("open");
    expect(index.snapshot().turns.get(0)?.status).toBe("closed");
  });
});

describe("ConversationLocationIndex: 增量追加", () => {
  it("新事件按当前打开的步骤归属", () => {
    const index = new ConversationLocationIndex();
    index.rebuild([]);
    index.appendBoundary(eventOf("turn/start", 1, { turn: 0 }));
    index.appendBoundary(eventOf("step/start", 2, { turn: 0, step: 0 }));
    const live = chunkOf(3, 0, 0);
    index.appendNonBoundary(live);

    const location = index.locationOf(live);
    expect(location).toMatchObject({ kind: "step" });
    expect(location.kind === "step" ? location.step.step : null).toBe(0);
  });

  it("步骤闭合后没有步骤归属的事件只属于轮次", () => {
    const index = new ConversationLocationIndex();
    index.rebuild([]);
    index.appendBoundary(eventOf("turn/start", 1, { turn: 0 }));
    index.appendBoundary(eventOf("step/start", 2, { turn: 0, step: 0 }));
    index.appendBoundary(eventOf("step/end", 3, { turn: 0, step: 0 }));
    const later = eventOf("notice", 4, { turn: 0 });
    index.appendNonBoundary(later);

    expect(index.locationOf(later)).toMatchObject({ kind: "turn" });
  });

  it("显式带步骤字段的事件仍归到该步骤，即使它已经闭合", () => {
    const index = new ConversationLocationIndex();
    index.rebuild([]);
    index.appendBoundary(eventOf("turn/start", 1, { turn: 0 }));
    index.appendBoundary(eventOf("step/start", 2, { turn: 0, step: 0 }));
    index.appendBoundary(eventOf("step/end", 3, { turn: 0, step: 0 }));
    const late = chunkOf(4, 0, 0);
    index.appendNonBoundary(late);

    expect(index.locationOf(late)).toMatchObject({ kind: "step" });
  });

  it("没有任何轮次时新事件是会话级", () => {
    const index = new ConversationLocationIndex();
    index.rebuild([]);
    const notice = eventOf("notice", 1, { turn: null });
    index.appendNonBoundary(notice);

    expect(index.locationOf(notice)).toEqual({ kind: "session" });
  });

  it("补齐轮次边界让该轮事件的归属从未知变为运行中", () => {
    const index = new ConversationLocationIndex();
    const orphan = eventOf("user/message", 1, { turn: 0, step: 0 });
    index.rebuild([entryOf(orphan)]);
    expect(index.snapshot().turns.get(0)?.status).toBe("unknown");

    const changed = index.appendBoundary(eventOf("turn/start", 2, { turn: 0 }));

    expect(changed.has(orphan.seq)).toBe(true);
    expect(index.snapshot().turns.get(0)?.status).toBe("open");
  });
});

describe("ConversationLocationIndex: 助手流式行与结算", () => {
  it("助手结算事件落在它的轮次与步骤上", () => {
    const index = new ConversationLocationIndex();
    index.rebuild([]);
    index.appendBoundary(eventOf("turn/start", 1, { turn: 0 }));
    index.appendBoundary(eventOf("step/start", 2, { turn: 0, step: 0 }));
    const settlement = eventOf("assistant/message", 3, {
      turn: 0,
      step: 0,
    }) as SessionEvent<"assistant/message">;
    index.insertAssistantSettlement(settlement);

    const location = index.locationOf(settlement);
    expect(location).toMatchObject({ kind: "step" });
    expect(location.kind === "step" ? location.step.step : null).toBe(0);
  });

  it("退役的流式行不再有位置", () => {
    const index = new ConversationLocationIndex();
    index.rebuild([]);
    index.appendBoundary(eventOf("turn/start", 1, { turn: 0 }));
    index.appendBoundary(eventOf("step/start", 2, { turn: 0, step: 0 }));
    const live = chunkOf(3, 0, 0);
    index.appendNonBoundary(live);
    expect(index.locationOf(live)).toMatchObject({ kind: "step" });

    index.removeAssistantTransients([live]);

    expect(index.locationOf(live)).toEqual({ kind: "session" });
  });
});

describe("ConversationLocationIndex: 位置数据", () => {
  function turnData(value: string): ConversationLocationData {
    return { kind: "turn", turn: 0, key: "todo", value } as unknown as ConversationLocationData;
  }

  it("发布的数据按轮次可读，并在发布时通知订阅者", () => {
    const { index } = seeded();
    const source = index
      .snapshot()
      .turns.get(0)
      ?.data.source("todo" as never);
    const listener = vi.fn();
    source?.subscribe(listener);

    expect(index.replaceData([{ owner: "todo:0", data: turnData("first") }])).toBe(true);
    index.publishData();

    expect(
      index
        .snapshot()
        .turns.get(0)
        ?.data.get("todo" as never),
    ).toBe("first");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("相同数据不重复发布，变更与移除都算变化", () => {
    const { index } = seeded();
    expect(index.replaceData([{ owner: "todo:0", data: turnData("first") }])).toBe(true);
    expect(index.replaceData([{ owner: "todo:0", data: turnData("first") }])).toBe(false);
    expect(index.replaceData([{ owner: "todo:0", data: turnData("second") }])).toBe(true);
    expect(index.replaceData([])).toBe(true);

    expect(
      index
        .snapshot()
        .turns.get(0)
        ?.data.get("todo" as never),
    ).toBeUndefined();
  });

  it("增量变更里移除旧值再写入新值", () => {
    const { index } = seeded();
    index.replaceData([{ owner: "todo:0", data: turnData("first") }]);

    index.applyData([
      {
        owner: "todo:0",
        previous: turnData("first"),
        next: turnData("second"),
      },
    ]);

    expect(
      index
        .snapshot()
        .turns.get(0)
        ?.data.get("todo" as never),
    ).toBe("second");
  });

  it("同一批数据里同一键被另一个所有者占用时失败", () => {
    const { index } = seeded();

    expect(() =>
      index.replaceData([
        { owner: "todo:0", data: turnData("first") },
        { owner: "other", data: turnData("hijack") },
      ]),
    ).toThrow(/already owned/u);
  });
});
