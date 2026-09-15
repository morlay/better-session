import { describe, expect, it } from "vitest";
import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  ToolCallId,
  ReasoningEffortId,
  createAssistantMessage,
  createUserMessage,
  LlmError,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, Message } from "@deepseek-ai/dsh-llm";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import type { AttachmentStore, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type {
  ResolvedModelProfile,
  ResolvedProviderProfile,
} from "@morlay/dsh-llm-openai-compatible";
import {
  resolveReasoningWire,
  serializeCallOptions,
  serializeCallOptionsWithImages,
} from "@morlay/dsh-llm-openai-compatible/wire";

function userMessage(text: string): Message {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function profile(overrides?: Partial<ResolvedProviderProfile>): ResolvedProviderProfile {
  return {
    provider: "test",
    displayName: "Test",
    baseURL: "https://example.com/v1",
    models: [],
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    maxRequestImageBytes: 20 * 1024 * 1024,
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, "test"),
    ...overrides,
  };
}

function model(overrides?: Partial<ResolvedModelProfile>): ResolvedModelProfile {
  return {
    id: "m1",
    inputModalities: ["text"],
    ...overrides,
  };
}

function options(overrides?: Partial<GenerateOptions>): GenerateOptions {
  return {
    provider: "test",
    model: "m1",
    messages: [userMessage("hi")],
    ...overrides,
  };
}

function expectToThrow(run: () => unknown): LlmError {
  try {
    run();
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw new Error(`expected an LlmError, got ${String(error)}`);
  }
  throw new Error("expected the call to throw");
}

describe("serializeCallOptions", () => {
  it("merges profile temperature under request-level temperature", async () => {
    const profiled = await serializeCallOptions(
      options(),
      profile({ temperature: 0.7 }),
      undefined,
    );
    expect(profiled.temperature).toBe(0.7);
    const requested = await serializeCallOptions(
      options({ temperature: 1.2 }),
      profile({ temperature: 0.7 }),
      undefined,
    );
    expect(requested.temperature).toBe(1.2);
  });

  it("omits temperature when neither request nor profile supplies one", async () => {
    const callOptions = await serializeCallOptions(options(), profile(), undefined);
    expect("temperature" in callOptions).toBe(false);
  });

  it("sends every configured sampling default and omits the unset ones", async () => {
    const callOptions = await serializeCallOptions(
      options(),
      profile({
        topP: 0.9,
        topK: 40,
        presencePenalty: 0.5,
        frequencyPenalty: -0.5,
        seed: 42,
      }),
      undefined,
    );
    expect(callOptions.topP).toBe(0.9);
    expect(callOptions.presencePenalty).toBe(0.5);
    expect(callOptions.frequencyPenalty).toBe(-0.5);
    expect(callOptions.seed).toBe(42);
    expect(callOptions.providerOptions?.["openai-compatible"]?.top_k).toBe(40);
    expect(callOptions.providerOptions?.["openai-compatible"]?.reasoningEffort).toBeUndefined();
  });

  it("merges maxOutputTokens: request > model > profile default", async () => {
    const fromProfile = await serializeCallOptions(
      options(),
      profile({ defaultMaxTokens: 4096 }),
      undefined,
    );
    expect(fromProfile.maxOutputTokens).toBe(4096);
    const fromModel = await serializeCallOptions(
      options(),
      profile({ defaultMaxTokens: 4096 }),
      model({ maxTokens: 8192 }),
    );
    expect(fromModel.maxOutputTokens).toBe(8192);
    const fromRequest = await serializeCallOptions(
      options({ maxTokens: 16_384 }),
      profile({ defaultMaxTokens: 4096 }),
      model({ maxTokens: 8192 }),
    );
    expect(fromRequest.maxOutputTokens).toBe(16_384);
  });

  it("maps a declared profile reasoning level to its wire spelling", async () => {
    const callOptions = await serializeCallOptions(
      options(),
      profile({ reasoning: "high" }),
      model({
        reasoningEfforts: { off: null, high: "high", max: "max" },
      }),
    );
    expect(callOptions.providerOptions?.["openai-compatible"]?.reasoningEffort).toBe("high");
  });

  it("prefers the request-level reasoning effort", async () => {
    const callOptions = await serializeCallOptions(
      options({ reasoningEffort: ReasoningEffortId("max") }),
      profile({ reasoning: "high" }),
      model({
        reasoningEfforts: { off: null, high: "high", max: "max" },
      }),
    );
    expect(callOptions.providerOptions?.["openai-compatible"]?.reasoningEffort).toBe("max");
  });

  it("omits reasoning_effort for the off level", async () => {
    const callOptions = await serializeCallOptions(
      options(),
      profile({ reasoning: "off" }),
      model({
        reasoningEfforts: { off: null, high: "high" },
      }),
    );
    expect(callOptions.providerOptions?.["openai-compatible"]?.reasoningEffort).toBeUndefined();
  });

  it("throws UNSUPPORTED_REASONING_EFFORT for a request-level effort the model lacks", async () => {
    await expect(
      serializeCallOptions(
        options({ reasoningEffort: ReasoningEffortId("low") }),
        profile(),
        model({
          reasoningEfforts: { off: null, high: "high" },
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_REASONING_EFFORT" });
  });

  it("throws UNSUPPORTED_REASONING_EFFORT for a profile default the model lacks", async () => {
    await expect(
      serializeCallOptions(
        options(),
        profile({ reasoning: "low" }),
        model({
          reasoningEfforts: { off: null, high: "high" },
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_REASONING_EFFORT" });
  });

  it("throws UNSUPPORTED_REASONING_EFFORT when an unlisted model has no reasoning declaration", async () => {
    await expect(
      serializeCallOptions(
        options({ reasoningEffort: ReasoningEffortId("high") }),
        profile(),
        undefined,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_REASONING_EFFORT" });
  });

  it("serializes tools only when non-empty", async () => {
    const withTools = await serializeCallOptions(
      options({ tools: [{ name: "f", description: "d", parameters: { type: "object" } }] }),
      profile(),
      undefined,
    );
    expect(withTools.tools).toEqual([
      { type: "function", name: "f", description: "d", inputSchema: { type: "object" } },
    ]);
    const bare = await serializeCallOptions(options(), profile(), undefined);
    expect("tools" in bare).toBe(false);
  });

  it("serializes stop sequences", async () => {
    const callOptions = await serializeCallOptions(
      options({ stop: ["END"] }),
      profile(),
      undefined,
    );
    expect(callOptions.stopSequences).toEqual(["END"]);
  });
});

describe("serializeCallOptions prompt", () => {
  it("keeps text-only user content and the system slot", async () => {
    const callOptions = await serializeCallOptions(
      options({ system: "sys" }),
      profile(),
      undefined,
    );
    expect(callOptions.prompt).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("expands tool results into standalone tool messages", async () => {
    const callId = ToolCallId("call_1");
    const messages = [
      createUserMessage({
        content: [
          { type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "42" }] },
        ],
        source: { kind: "tool", callId },
      }),
    ];
    const callOptions = await serializeCallOptions(options({ messages }), profile(), undefined);
    expect(callOptions.prompt).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "",
            output: { type: "text", value: "42" },
          },
        ],
      },
    ]);
  });

  it("carries assistant reasoning, tool calls, and resolves tool names for results", async () => {
    const callId = ToolCallId("call_1");
    const assistant = createAssistantMessage({
      content: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "answer" },
        { type: "tool-call", id: callId, name: "f", arguments: '{"a":1}' },
      ],
      source: { provider: "test", model: "m1" },
    });
    const result = createUserMessage({
      content: [
        { type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "ok" }] },
      ],
      source: { kind: "tool", callId },
    });
    const callOptions = await serializeCallOptions(
      options({ messages: [assistant, result] }),
      profile(),
      undefined,
    );
    expect(callOptions.prompt).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "think" },
          { type: "text", text: "answer" },
          { type: "tool-call", toolCallId: "call_1", toolName: "f", input: { a: 1 } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "f",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]);
  });
});

describe("resolveReasoningWire", () => {
  it("returns the declared wire spelling for a supported effort", () => {
    expect(
      resolveReasoningWire(model({ reasoningEfforts: { off: null, max: "ultra" } }), "max"),
    ).toBe("ultra");
  });

  it("returns undefined for off (omit the field)", () => {
    expect(resolveReasoningWire(model({ reasoningEfforts: { off: null } }), "off")).toBeUndefined();
  });

  it("returns undefined when no effort is resolved", () => {
    expect(
      resolveReasoningWire(model({ reasoningEfforts: { off: null } }), undefined),
    ).toBeUndefined();
  });

  it("rejects a false declaration", () => {
    const error = expectToThrow(() =>
      resolveReasoningWire(model({ reasoningEfforts: false }), "high"),
    );
    expect(error.code).toBe("UNSUPPORTED_REASONING_EFFORT");
  });
});

function retainedImage(): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${"b".repeat(64)}`),
    mediaType: "image/png",
    bytes: 1024,
    width: 1,
    height: 1,
  };
}

function attachments(): AttachmentStore {
  return {
    readImage: (ref: ImageAttachmentRef) =>
      Promise.resolve({ ref, data: new Uint8Array([1, 2, 3]) }),
  } as unknown as AttachmentStore;
}

function imageMessage(offloaded?: true): Message {
  const attachment = retainedImage();
  return createUserMessage({
    content: [{ type: "image", attachment, ...(offloaded === undefined ? {} : { offloaded }) }],
    source: { kind: "user" },
  });
}

async function expectToReject(run: () => Promise<unknown>): Promise<LlmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw new Error(`expected an LlmError, got ${String(error)}`);
  }
  throw new Error("expected the call to throw");
}

describe("serializeCallOptionsWithImages", () => {
  const budget = 20 * 1024 * 1024;

  function serialize(messages: readonly Message[], maxRequestImageBytes: number = budget) {
    return serializeCallOptionsWithImages(
      options({ messages: [...messages] }),
      profile({ maxRequestImageBytes }),
      model({ inputModalities: ["text", "image"] }),
      { attachments: attachments(), maxRequestImageBytes },
    );
  }

  it("inlines a retained image as a base64 data URL", async () => {
    const result = await serialize([imageMessage()]);
    expect(JSON.stringify(result.prompt)).toContain("data:image/png;base64,");
  });

  it("sends placeholder text for an occurrence the surface already offloaded", async () => {
    const result = await serialize([imageMessage(true)]);
    const serialized = JSON.stringify(result.prompt);
    expect(serialized).toContain("image omitted to fit request image limits");
    expect(serialized).not.toContain("data:image/png;base64,");
  });

  it("fails loud with IMAGE_OFFLOAD_REQUIRED instead of offloading on its own", async () => {
    const error = await expectToReject(() => serialize([imageMessage()], 1));
    expect(error.code).toBe(IMAGE_OFFLOAD_REQUIRED_CODE);
    expect(error.failure.offloadImages).toBe(1);
  });
});
