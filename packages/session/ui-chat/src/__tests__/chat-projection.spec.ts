// 会话事件到聊天视图节点的投影：消息按来源分流（用户 / steering / 注入上下文），
// 助手步骤给出运行 / 结算 / 中断三态，轮次收尾带指标，未知事件走兜底。
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type {
  AssistantLiveChunkEvent,
  SessionEventLikeEntry,
} from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  ConversationEventRegistry,
  ConversationNodeAssembler,
  ConversationViewRegistry,
} from "@morlay/dsh-client-ui-conversation/client";
import type { ChatConversationViewNode } from "../client/contract/chat-nodes.ts";
import type { ChatSnapshot } from "../client/contract/snapshot.ts";
import { assistantDefinition } from "../client/conversation-nodes/assistant.ts";
import { chatViewDefinition } from "../client/conversation-nodes/chat-snapshot-builder.ts";
import { commandDefinition } from "../client/conversation-nodes/command.ts";
import { compactionDefinition } from "../client/conversation-nodes/compaction.ts";
import { unknownFallbackDefinition } from "../client/conversation-nodes/fallback.ts";
import { nextStepInboxDefinition } from "../client/conversation-nodes/inbox.ts";
import { messageDefinition } from "../client/conversation-nodes/message.ts";
import { retryDefinition } from "../client/conversation-nodes/retry.ts";
import { toolDefinition } from "../client/conversation-nodes/tool.ts";
import { turnErrorDefinition } from "../client/conversation-nodes/turn-error.ts";
import { turnMaxTokensDefinition } from "../client/conversation-nodes/turn-max-tokens.ts";
import { turnProcessDefinition } from "../client/conversation-nodes/turn-process.ts";
import { turnTailDefinition } from "../client/conversation-nodes/turn-tail.ts";

function eventEntry(event: SessionEvent): SessionEventLikeEntry {
  return { type: "event", event };
}

function transient(event: AssistantLiveChunkEvent): SessionEventLikeEntry {
  return { type: "transient", event };
}

function chatOf(entries: readonly SessionEventLikeEntry[]): ChatSnapshot {
  const ctx = new Context();
  const events = new ConversationEventRegistry(ctx);
  const views = new ConversationViewRegistry(ctx);
  const assembler = new ConversationNodeAssembler(events, views);
  for (const definition of [
    nextStepInboxDefinition,
    messageDefinition,
    assistantDefinition,
    turnProcessDefinition,
    toolDefinition,
    commandDefinition,
    compactionDefinition,
    retryDefinition,
    turnErrorDefinition,
    turnMaxTokensDefinition,
    turnTailDefinition,
  ])
    events.register(definition);
  events.registerFallback(unknownFallbackDefinition);
  views.register(chatViewDefinition);
  assembler.rebuildRegistry();
  assembler.replaceWindow(entries, false);
  assembler.activateTarget("chat");
  assembler.flush();
  const snapshot = assembler.get("chat");
  if (snapshot === undefined) throw new Error("ui-chat: no chat snapshot was built");
  return snapshot;
}

function kindsOf(snapshot: ChatSnapshot): readonly (string | undefined)[] {
  return snapshot.order.map((key) => snapshot.nodes.get(key)?.kind);
}

function nodeOf(snapshot: ChatSnapshot, kind: string): ChatConversationViewNode {
  const key = snapshot.order.find((candidate) => snapshot.nodes.get(candidate)?.kind === kind);
  if (key === undefined)
    throw new Error(`ui-chat: no "${kind}" node in ${String(kindsOf(snapshot))}`);
  return snapshot.nodes.get(key) as ChatConversationViewNode;
}

function dataOf<Data>(snapshot: ChatSnapshot, kind: string): Data {
  return nodeOf(snapshot, kind).data as Data;
}

function turnStart(seq: number, turn: number, time = seq): SessionEvent {
  return { type: "turn/start", seq: SessionSeq(seq), time, data: { turn } };
}

function turnEnd(seq: number, turn: number, reason: unknown, time = seq): SessionEvent {
  return { type: "turn/end", seq: SessionSeq(seq), time, data: { turn, reason } } as SessionEvent;
}

function stepStart(seq: number, turn: number, step: number, time = seq): SessionEvent {
  return { type: "step/start", seq: SessionSeq(seq), time, data: { turn, step } };
}

function stepEnd(seq: number, turn: number, step: number, time = seq): SessionEvent {
  return { type: "step/end", seq: SessionSeq(seq), time, data: { turn, step } };
}

function userMessage(
  seq: number,
  id: string,
  text: string,
  source: unknown = { kind: "user" },
  time = seq,
): SessionEvent {
  return {
    type: "user/message",
    seq: SessionSeq(seq),
    time,
    data: { id, role: "user", content: [{ type: "text", text }], source },
    surfaceOp: "append",
  } as unknown as SessionEvent;
}

function assistantMessage(
  seq: number,
  turn: number,
  step: number,
  text: string,
  time = seq,
  extra: { usage?: unknown; interrupted?: boolean } = {},
): SessionEvent {
  return {
    type: "assistant/message",
    seq: SessionSeq(seq),
    time,
    data: {
      turn,
      step,
      message: {
        id: `a-${seq}`,
        role: "assistant",
        content: [{ type: "text", text }],
        source: { kind: "model", provider: "mock", model: "mock" },
      },
      stream: [],
      ...extra,
    },
    surfaceOp: "append",
  } as unknown as SessionEvent;
}

function textDelta(
  seq: number,
  turn: number,
  step: number,
  text: string,
  time = seq,
): SessionEventLikeEntry {
  return transient({
    type: "assistant/live-chunk",
    seq,
    time,
    data: {
      attemptId: "attempt-1",
      turn,
      step,
      chunk: { type: "text-delta", index: 0, text },
    },
  } as unknown as AssistantLiveChunkEvent);
}

function inboxSplice(
  seq: number,
  data: {
    target: "next-turn" | "next-step";
    start: number;
    removedCount?: number;
    inserted?: readonly string[];
  },
): SessionEvent {
  return {
    type: "agent/inbox/spliced",
    seq: SessionSeq(seq),
    time: seq,
    data: {
      target: data.target,
      start: data.start,
      removedCount: data.removedCount ?? 0,
      inserted: (data.inserted ?? []).map((id) => ({ id })),
    },
  } as unknown as SessionEvent;
}

describe("消息分流", () => {
  it("renders a plain user message inside its turn", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(userMessage(1, "m1", "你好")),
      eventEntry(stepStart(2, 1, 1)),
      eventEntry(assistantMessage(3, 1, 1, "回答")),
      eventEntry(stepEnd(4, 1, 1)),
      eventEntry(turnEnd(5, 1, { kind: "completed" })),
    ]);
    expect(kindsOf(snapshot)).toEqual(["user", "turn-process", "assistant-step", "turn-tail"]);
    // user/message 早于本轮的 step/start，归属整个轮次。
    expect(nodeOf(snapshot, "user").location.kind).toBe("turn");
    expect(dataOf<{ content: readonly unknown[] }>(snapshot, "user").content).toEqual([
      { type: "text", text: "你好" },
    ]);
  });

  it("keeps a user message that arrives outside any turn", () => {
    const snapshot = chatOf([
      eventEntry(userMessage(1, "m1", "轮外")),
      eventEntry(userMessage(2, "m2", "再来一条")),
    ]);
    expect(kindsOf(snapshot)).toEqual(["user", "user"]);
    expect(nodeOf(snapshot, "user").location.kind).toBe("session");
  });

  it("routes a plugin-injected message to the context row", () => {
    const snapshot = chatOf([
      eventEntry(
        userMessage(1, "ctx-1", "instructions body", {
          kind: "agent-instructions",
          changes: [{ path: "AGENTS.md" }],
        }),
      ),
    ]);
    expect(kindsOf(snapshot)).toEqual(["context"]);
    expect(
      dataOf<{ producer: unknown; source: { kind: string } }>(snapshot, "context"),
    ).toMatchObject({
      producer: { role: "inject", label: "AGENTS.md" },
      source: { kind: "agent-instructions" },
    });
  });

  it("routes a message the next-step inbox consumed to steering", () => {
    const snapshot = chatOf([
      eventEntry(inboxSplice(1, { target: "next-step", start: 0, inserted: ["s1"] })),
      eventEntry(inboxSplice(2, { target: "next-step", start: 0, removedCount: 1 })),
      eventEntry(userMessage(3, "s1", "改一下方向")),
    ]);
    expect(kindsOf(snapshot)).toEqual(["steering"]);
    expect(dataOf<{ messageId: string }>(snapshot, "steering").messageId).toBe("s1");
  });

  it("keeps a merely queued steering message as an ordinary user message", () => {
    const snapshot = chatOf([
      eventEntry(inboxSplice(1, { target: "next-step", start: 0, inserted: ["s1"] })),
      eventEntry(userMessage(2, "s1", "还没轮到我")),
    ]);
    expect(kindsOf(snapshot)).toEqual(["user"]);
  });
});

describe("助手步骤", () => {
  it("shows a running step with the streamed text", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(stepStart(1, 1, 1)),
      textDelta(2, 1, 1, "你"),
      textDelta(3, 1, 1, "好"),
    ]);
    expect(kindsOf(snapshot)).toContain("assistant-step");
    const data = dataOf<{ status: string; blocks: readonly unknown[]; finalNode?: unknown }>(
      snapshot,
      "assistant-step",
    );
    expect(data.status).toBe("running");
    expect(data.blocks).toEqual([{ kind: "text", text: "你好" }]);
    expect(data.finalNode).toBeUndefined();
  });

  it("settles the step on the final assistant message", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(stepStart(1, 1, 1)),
      textDelta(2, 1, 1, "半句"),
      eventEntry(assistantMessage(3, 1, 1, "完整回答")),
    ]);
    const data = dataOf<{
      status: string;
      blocks: readonly unknown[];
      finalNode: { seq: number; blocks: readonly unknown[] };
    }>(snapshot, "assistant-step");
    expect(data.status).toBe("settled");
    expect(data.blocks).toEqual([{ kind: "text", text: "完整回答" }]);
    expect(data.finalNode.seq).toBe(3);
  });

  it("marks a step that only streamed text as interrupted at the turn end", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(stepStart(1, 1, 1)),
      textDelta(2, 1, 1, "说了一半"),
      eventEntry(stepEnd(3, 1, 1)),
      eventEntry(turnEnd(4, 1, { kind: "interrupted" })),
    ]);
    expect(dataOf<{ status: string }>(snapshot, "assistant-step").status).toBe("interrupted");
  });

  it("hides a step that produced nothing visible", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(stepStart(1, 1, 1)),
      eventEntry(assistantMessage(2, 1, 1, "")),
      eventEntry(stepEnd(3, 1, 1)),
      eventEntry(turnEnd(4, 1, { kind: "completed" })),
    ]);
    expect(kindsOf(snapshot)).not.toContain("assistant-step");
  });
});

describe("轮次收尾", () => {
  it("reports the closing answer of a completed turn", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1, 1_000)),
      eventEntry(stepStart(1, 1, 1, 1_000)),
      textDelta(2, 1, 1, "答", 1_500),
      eventEntry(assistantMessage(3, 1, 1, "最终回答", 2_500, { usage: { outputTokens: 50 } })),
      eventEntry(stepEnd(4, 1, 1, 2_600)),
      eventEntry(turnEnd(5, 1, { kind: "completed" }, 2_700)),
    ]);
    const data = dataOf<{
      turn: number;
      closing: { blocks: readonly unknown[] } | null;
      branchUnavailable: boolean;
      ttftMs?: number;
      tokensPerSecond?: number;
    }>(snapshot, "turn-tail");
    expect(data.turn).toBe(1);
    expect(data.closing?.blocks).toEqual([{ kind: "text", text: "最终回答" }]);
    expect(data.branchUnavailable).toBe(false);
    expect(data.ttftMs).toBe(500);
    expect(data.tokensPerSecond).toBe(50);
  });

  it("has no tail before the turn ends", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(userMessage(1, "m1", "你好")),
    ]);
    expect(kindsOf(snapshot)).not.toContain("turn-tail");
  });
});

describe("轮次终态提示", () => {
  it("surfaces a turn error with its code", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(stepStart(1, 1, 1)),
      eventEntry(stepEnd(2, 1, 1)),
      eventEntry(
        turnEnd(3, 1, { kind: "error", error: { code: "RATE_LIMIT", message: "慢一点" } }),
      ),
    ]);
    const data = dataOf<{ turn: number; message: string; code?: string }>(snapshot, "turn-error");
    expect(data.turn).toBe(1);
    expect(data.code).toBe("RATE_LIMIT");
    expect(data.message).toBe("慢一点");
  });

  it("hides the provider message of an auth failure", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(turnEnd(1, 1, { kind: "error", error: { code: "AUTH", message: "bad key" } })),
    ]);
    expect(dataOf<{ message: string; code?: string }>(snapshot, "turn-error")).toMatchObject({
      code: "AUTH",
      message: "",
    });
  });

  it("notes a turn that stopped at the output cap", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(turnEnd(1, 1, { kind: "max-tokens" })),
    ]);
    expect(dataOf<{ turn: number }>(snapshot, "turn-max-tokens").turn).toBe(1);
  });
});

describe("模型重试", () => {
  it("groups the retry attempts of one retry id", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(stepStart(1, 1, 1)),
      eventEntry({
        type: "llm/retry",
        seq: SessionSeq(2),
        time: 2,
        data: {
          retryId: "r1",
          turn: 1,
          step: 1,
          provider: "mock",
          mode: "normal",
          policyKey: "default",
          retry: 1,
          maxRetries: 3,
          delayMs: 2_000,
          failure: { code: "RATE_LIMIT", message: "慢一点" },
        },
      } as unknown as SessionEvent),
      eventEntry({
        type: "llm/retry",
        seq: SessionSeq(3),
        time: 3,
        data: {
          retryId: "r1",
          turn: 1,
          step: 1,
          provider: "mock",
          mode: "normal",
          policyKey: "default",
          retry: 2,
          maxRetries: 3,
          delayMs: 4_000,
          failure: { code: "RATE_LIMIT", message: "再慢一点" },
        },
      } as unknown as SessionEvent),
    ]);
    const data = dataOf<{
      attempts: readonly { retry: number; retryState: string }[];
      current: { retry: number; retryState: string };
    }>(snapshot, "model-retry");
    expect(data.attempts.map((attempt) => attempt.retry)).toEqual([1, 2]);
    expect(data.current.retryState).toBe("scheduled");
  });
});

describe("工具调用", () => {
  it("settles the root call with its result", () => {
    const snapshot = chatOf([
      eventEntry(turnStart(0, 1)),
      eventEntry(stepStart(1, 1, 1)),
      eventEntry({
        type: "tool/call",
        seq: SessionSeq(2),
        time: 2,
        data: { callId: "c1", name: "bash", arguments: '{"cmd":"ls"}', turn: 1, step: 1 },
      } as unknown as SessionEvent),
      eventEntry({
        type: "tool/result",
        seq: SessionSeq(3),
        time: 3,
        data: {
          message: {
            id: "r1",
            role: "tool",
            content: [{ content: [{ type: "text", text: "ok" }], isError: false }],
            source: { kind: "tool", callId: "c1" },
          },
          turn: 1,
          step: 1,
        },
        surfaceOp: "append",
      } as unknown as SessionEvent),
    ]);
    const data = dataOf<{ root: { kind: string; callId: string; content: readonly unknown[] } }>(
      snapshot,
      "tool-call",
    );
    expect(data.root.kind).toBe("tool-result");
    expect(data.root.callId).toBe("c1");
    expect(data.root.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("未知事件", () => {
  it("falls back to an unknown surface node", () => {
    const snapshot = chatOf([
      eventEntry({
        type: "system/message",
        seq: SessionSeq(1),
        time: 1,
        data: { message: { content: [{ type: "text", text: "系统提示" }] } },
        surfaceOp: "append",
      } as unknown as SessionEvent),
    ]);
    expect(kindsOf(snapshot)).toEqual(["unknown"]);
    expect(dataOf<{ type: string; data: unknown }>(snapshot, "unknown").type).toBe(
      "system/message",
    );
  });
});
