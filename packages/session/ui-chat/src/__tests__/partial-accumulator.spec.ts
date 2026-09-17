// 流式助手块的增量累积：文本 / 思考 / 工具调用按 index 追加，block-end 用官方块覆盖，
// 只有可见 chunk 才需要渲染。
import { describe, expect, it } from "vitest";
import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import type { StreamChunk } from "@deepseek-ai/dsh-llm/types";
import {
  isVisibleAssistantChunk,
  PartialAccumulator,
} from "../client/conversation-nodes/partial.ts";

describe("PartialAccumulator", () => {
  it("starts with the blocks it was seeded with", () => {
    const accumulator = new PartialAccumulator(1, 1, [{ kind: "text", text: "seed" }]);
    expect(accumulator.toPartial()).toEqual({
      turn: 1,
      step: 1,
      blocks: [{ kind: "text", text: "seed" }],
    });
  });

  it("accumulates a text delta stream", () => {
    const accumulator = new PartialAccumulator(2, 3);
    accumulator.push({ type: "block-start", index: 0, blockType: "text" });
    accumulator.push({ type: "text-delta", index: 0, text: "你" });
    accumulator.push({ type: "text-delta", index: 0, text: "好" });
    expect(accumulator.toPartial().blocks).toEqual([{ kind: "text", text: "你好" }]);
  });

  it("accumulates a reasoning delta stream", () => {
    const accumulator = new PartialAccumulator(1, 1);
    accumulator.push({ type: "reasoning-delta", index: 0, text: "因" });
    accumulator.push({ type: "reasoning-delta", index: 0, text: "此" });
    expect(accumulator.toPartial().blocks).toEqual([{ kind: "reasoning", text: "因此" }]);
  });

  it("accumulates tool-call arguments and keeps the name", () => {
    const accumulator = new PartialAccumulator(1, 1);
    accumulator.push({
      type: "tool-call-delta",
      index: 0,
      id: ToolCallId("c1"),
      name: "bash",
      argumentsDelta: '{"cmd"',
    });
    accumulator.push({
      type: "tool-call-delta",
      index: 0,
      id: ToolCallId("c1"),
      argumentsDelta: ':"ls"}',
    });
    expect(accumulator.toPartial().blocks).toEqual([
      { kind: "tool-call", callId: "c1", name: "bash", argsRaw: '{"cmd":"ls"}' },
    ]);
  });

  it("replaces the streamed block with the finalized one", () => {
    const accumulator = new PartialAccumulator(1, 1);
    accumulator.push({ type: "text-delta", index: 0, text: "半句" });
    accumulator.push({ type: "block-end", index: 0, block: { type: "text", text: "完整一句" } });
    expect(accumulator.toPartial().blocks).toEqual([{ kind: "text", text: "完整一句" }]);
  });

  it("keeps blocks of separate indices apart", () => {
    const accumulator = new PartialAccumulator(1, 1);
    accumulator.push({ type: "reasoning-delta", index: 0, text: "想" });
    accumulator.push({ type: "text-delta", index: 1, text: "答" });
    expect(accumulator.toPartial().blocks).toEqual([
      { kind: "reasoning", text: "想" },
      { kind: "text", text: "答" },
    ]);
  });

  it("leaves the snapshot alone for a chunk it does not accumulate", () => {
    const accumulator = new PartialAccumulator(1, 1);
    accumulator.push({ type: "text-delta", index: 0, text: "a" });
    const before = accumulator.toPartial();
    expect(accumulator.push({ type: "finish", reason: { kind: "stop" } } as StreamChunk)).toBe(
      false,
    );
    expect(accumulator.toPartial()).toBe(before);
  });

  it("tracks the turn and step it was created for", () => {
    expect(new PartialAccumulator(4, 2).toPartial()).toMatchObject({
      turn: 4,
      step: 2,
      blocks: [],
    });
  });
});

describe("isVisibleAssistantChunk", () => {
  it("accepts the chunks that change what the reader sees", () => {
    expect(isVisibleAssistantChunk("block-start")).toBe(true);
    expect(isVisibleAssistantChunk("text-delta")).toBe(true);
    expect(isVisibleAssistantChunk("reasoning-delta")).toBe(true);
    expect(isVisibleAssistantChunk("tool-call-delta")).toBe(true);
    expect(isVisibleAssistantChunk("block-end")).toBe(true);
  });

  it("rejects bookkeeping chunks", () => {
    expect(isVisibleAssistantChunk("usage")).toBe(false);
    expect(isVisibleAssistantChunk("finish")).toBe(false);
  });
});
