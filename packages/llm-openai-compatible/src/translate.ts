/**
 * Translate AI SDK `LanguageModelV4StreamPart`s (as produced by
 * `@ai-sdk/openai-compatible`'s `doStream`) into the harness `StreamChunk`
 * protocol. One stateful harness block per text, reasoning, or tool-call
 * index; `block-end`s, `usage`, and `finish` are all deferred to the stream's
 * `finish` part so nothing follows the terminal finish.
 * @module dsh-llm-openai-compatible/translate
 */

import { EMPTY_RESPONSE_CODE, ToolCallId, LlmError } from "@deepseek-ai/dsh-llm";
import type { FinishReason, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/** Map the AI SDK finish-reason vocabulary to the harness FinishReason. */
export function mapFinishReason(reason: LanguageModelV4FinishReason): FinishReason {
  switch (reason.unified) {
    case "stop":
      return { kind: "stop" };
    case "tool-calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return {
        kind: "error",
        failure: {
          message: `model stopped: ${reason.raw ?? reason.unified}`,
          code: (reason.raw ?? reason.unified).toUpperCase(),
        },
      };
  }
}

/** Map AI SDK usage (already disjoint by the provider converter) to harness counts. */
export function mapUsage(usage: LanguageModelV4Usage): TokenUsage {
  const cacheRead = usage.inputTokens.cacheRead;
  const reasoning = usage.outputTokens.reasoning;
  return {
    inputTokens: usage.inputTokens.noCache ?? usage.inputTokens.total ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    ...(cacheRead !== void 0 && cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== void 0 && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

interface OpenBlock {
  index: number;
  kind: "text" | "reasoning" | "tool-call";
  text: string;
  callId?: string;
  name?: string;
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): Extract<StreamChunk, { type: "block-end" }>["block"] {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return {
        type: "tool-call",
        id: ToolCallId(block.callId ?? ""),
        name: block.name ?? "",
        arguments: block.text,
      };
  }
}

/**
 * Consume the AI SDK stream and yield StreamChunks. The `finish` part closes
 * every open block, reports usage, and emits the terminal finish; an empty
 * `stop` completion maps to `EMPTY_RESPONSE`. A stream-level `error` part
 * aborts with `TRANSPORT`.
 * @param stream - the `doStream` result stream.
 * @returns harness chunks in order; the terminal `finish` is always last.
 */
export async function* translate(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): AsyncGenerator<StreamChunk, void> {
  let nextIndex = 0;
  const textBlocks = new Map<string, OpenBlock>();
  const reasoningBlocks = new Map<string, OpenBlock>();
  const toolBlocks = new Map<string, OpenBlock>();
  const toolQueue: OpenBlock[] = [];
  const order: OpenBlock[] = [];
  let pendingUsage: TokenUsage | undefined;
  let pendingFinish: FinishReason | undefined;

  const open = (kind: OpenBlock["kind"]): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  };

  for await (const part of stream) {
    switch (part.type) {
      case "stream-start":
      case "response-metadata":
      case "raw":
        break;
      case "text-start": {
        const block = open("text");
        textBlocks.set(part.id, block);
        yield { type: "block-start", index: block.index, blockType: "text" };
        break;
      }
      case "text-delta": {
        const block = textBlocks.get(part.id);
        if (block === void 0) break;
        block.text += part.delta;
        yield { type: "text-delta", index: block.index, text: part.delta };
        break;
      }
      case "text-end":
        break;
      case "reasoning-start": {
        const block = open("reasoning");
        reasoningBlocks.set(part.id, block);
        yield { type: "block-start", index: block.index, blockType: "reasoning" };
        break;
      }
      case "reasoning-delta": {
        const block = reasoningBlocks.get(part.id);
        if (block === void 0) break;
        block.text += part.delta;
        yield { type: "reasoning-delta", index: block.index, text: part.delta };
        break;
      }
      case "reasoning-end":
        break;
      case "tool-input-start": {
        const block = open("tool-call");
        if (part.toolName !== void 0) block.name = part.toolName;
        toolBlocks.set(part.id, block);
        toolQueue.push(block);
        yield { type: "block-start", index: block.index, blockType: "tool-call" };
        break;
      }
      case "tool-input-delta": {
        const block = toolBlocks.get(part.id);
        if (block === void 0) break;
        block.text += part.delta;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: ToolCallId(block.callId ?? part.id),
          ...(block.name !== void 0 ? { name: block.name } : {}),
          argumentsDelta: part.delta,
        };
        break;
      }
      case "tool-input-end":
        break;
      case "tool-call": {
        applyToolCall(part, toolQueue);
        break;
      }
      case "tool-result":
      case "tool-approval-request":
      case "custom":
      case "file":
      case "reasoning-file":
      case "source":
        // Provider-executed tools and generated files are not part of this
        // adapter's client-executed tool loop; nothing to emit.
        break;
      case "finish":
        pendingUsage = mapUsage(part.usage);
        pendingFinish = mapFinishReason(part.finishReason);
        for (const block of order)
          yield { type: "block-end", index: block.index, block: closeBlock(block) };
        if (pendingUsage !== void 0) yield { type: "usage", usage: pendingUsage };
        const reason = pendingFinish ?? { kind: "stop" as const };
        yield {
          type: "finish",
          reason:
            reason.kind === "stop" && order.length === 0
              ? {
                  kind: "error",
                  failure: {
                    message: "model returned a completed response with no content",
                    code: EMPTY_RESPONSE_CODE,
                  },
                }
              : reason,
        };
        return;
      case "error": {
        const error = part.error;
        const cause = error instanceof Error ? error : void 0;
        const message =
          cause?.message ?? (typeof error === "string" ? error : "provider stream error");
        throw new LlmError(`OpenAI-compatible stream failed: ${message}`, "TRANSPORT", { cause });
      }
    }
  }
  throw new LlmError("AI SDK stream ended without a finish part", "STREAM_CLOSED");
}

/** Merge a complete tool-call part into the oldest buffered tool block. */
function applyToolCall(part: LanguageModelV4ToolCall, toolQueue: OpenBlock[]): void {
  const block = toolQueue.shift();
  if (block === void 0) return;
  block.callId = part.toolCallId;
  block.name = part.toolName;
  // The provider emits the complete arguments on this part; the buffered
  // deltas were a partial view.
  block.text = part.input;
}
