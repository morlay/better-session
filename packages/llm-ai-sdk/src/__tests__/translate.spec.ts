import { describe, expect, it } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { mapFinishReason, mapUsage, translate } from "@morlay/dsh-llm-ai-sdk/wire";

function streamOf(
  ...parts: LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of translate(stream)) out.push(chunk);
  return out;
}

const usage = (overrides?: object): Parameters<typeof mapUsage>[0] => ({
  inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: void 0 },
  outputTokens: { total: 3, text: 1, reasoning: 2 },
  ...overrides,
});

describe("mapFinishReason", () => {
  it("maps the unified vocabulary", () => {
    expect(mapFinishReason({ unified: "stop", raw: "stop" })).toEqual({ kind: "stop" });
    expect(mapFinishReason({ unified: "tool-calls", raw: "tool_calls" })).toEqual({
      kind: "tool-calls",
    });
    expect(mapFinishReason({ unified: "length", raw: "length" })).toEqual({ kind: "max-tokens" });
  });

  it("turns content-filter and other reasons into error finishes", () => {
    expect(mapFinishReason({ unified: "content-filter", raw: "content_filter" })).toEqual({
      kind: "error",
      failure: { message: "model stopped: content_filter", code: "CONTENT_FILTER" },
    });
  });
});

describe("mapUsage", () => {
  it("maps disjoint AI SDK usage to harness counts", () => {
    expect(mapUsage(usage())).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      cacheReadTokens: 2,
      reasoningTokens: 2,
    });
  });

  it("omits zero cache and reasoning fields", () => {
    expect(
      mapUsage({
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: void 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 3 });
  });
});

describe("translate", () => {
  it("emits one text block and defers block-end/usage/finish to the finish part", async () => {
    const chunks = await collect(
      streamOf(
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hel" },
        { type: "text-delta", id: "t1", delta: "lo" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
      ),
    );
    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "hel" },
      { type: "text-delta", index: 0, text: "lo" },
      { type: "block-end", index: 0, block: { type: "text", text: "hello" } },
      {
        type: "usage",
        usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 2 },
      },
      { type: "finish", reason: { kind: "stop" } },
    ]);
  });

  it("emits reasoning deltas alongside text", async () => {
    const chunks = await collect(
      streamOf(
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "think " },
        { type: "reasoning-end", id: "r1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "answer" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() },
      ),
    );
    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "think " },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "answer" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "think " } },
      { type: "block-end", index: 1, block: { type: "text", text: "answer" } },
      {
        type: "usage",
        usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 2 },
      },
      { type: "finish", reason: { kind: "stop" } },
    ]);
  });

  it("assembles tool calls across fragmented deltas and a complete part", async () => {
    const chunks = await collect(
      streamOf(
        { type: "tool-input-start", id: "sdk1", toolName: "f" },
        { type: "tool-input-delta", id: "sdk1", delta: '{"a":' },
        { type: "tool-input-delta", id: "sdk1", delta: "1}" },
        { type: "tool-input-end", id: "sdk1" },
        { type: "tool-call", toolCallId: "call_1", toolName: "f", input: '{"a":1}' },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: usage(),
        },
      ),
    );
    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id: "sdk1", name: "f", argumentsDelta: '{"a":' },
      { type: "tool-call-delta", index: 0, id: "sdk1", name: "f", argumentsDelta: "1}" },
      {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: "call_1", name: "f", arguments: '{"a":1}' },
      },
      {
        type: "usage",
        usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 2 },
      },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
  });

  it("maps an empty completion to EMPTY_RESPONSE", async () => {
    const chunks = await collect(
      streamOf({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() }),
    );
    expect(chunks).toHaveLength(2);
    const finish = chunks[1] as Extract<StreamChunk, { type: "finish" }>;
    expect(finish.type).toBe("finish");
    expect(finish.reason.kind).toBe("error");
    if (finish.reason.kind === "error") {
      expect(finish.reason.failure.code).toBe("EMPTY_RESPONSE");
    }
  });

  it("throws STREAM_CLOSED when the stream ends without a finish part", async () => {
    await expect(
      collect(
        streamOf({ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "hi" }),
      ),
    ).rejects.toMatchObject({ code: "STREAM_CLOSED" });
  });

  it("throws TRANSPORT on a stream-level error part", async () => {
    await expect(
      collect(streamOf({ type: "error", error: new Error("boom") })),
    ).rejects.toMatchObject({ code: "TRANSPORT" });
  });
});
