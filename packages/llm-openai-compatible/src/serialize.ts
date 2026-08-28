/**
 * Serialize harness messages into the AI SDK `LanguageModelV4Prompt` and merge
 * profile sampling defaults into call options for
 * `@ai-sdk/openai-compatible`. Request-level `GenerateOptions` wins, profile
 * values fill in, and anything still undefined is omitted so the provider's
 * own default applies. `topK` and the wire `reasoning_effort` spelling travel
 * through `providerOptions["openai-compatible"]`, which the provider
 * transparently forwards into the request body.
 * @module dsh-llm-openai-compatible/serialize
 */

import {
  LlmError,
  contentHasImage,
  offloadRequestImagesWithPolicy,
  textOnlyImageText,
} from "@deepseek-ai/dsh-llm";
import type { ContentBlock, GenerateOptions, Message } from "@deepseek-ai/dsh-llm";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { Buffer } from "node:buffer";
import type { ReasoningEffort, ResolvedModelProfile, ResolvedProviderProfile } from "./adapter.ts";

/** Lead-in text of the user message that follows tool-result images. */
const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";

/** A user-message content part the adapter understands. */
type UserContentPart = Extract<LanguageModelV4Prompt[number], { role: "user" }>["content"][number];

/** Provider-specific options the adapter forwards into the request body. */
export type OpenAICompatibleProviderOptions = SharedV4ProviderOptions & {
  "openai-compatible"?: {
    /** Exact wire `reasoning_effort` spelling; absence omits the field. */
    reasoningEffort?: string;
    /** Non-standard `top_k` sampling knob, sent only to gateways that accept it. */
    top_k?: number;
  };
};

/** The per-call options resolved from one harness request and provider profile. */
export interface OpenAICompatibleCallOptions {
  prompt: LanguageModelV4Prompt;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: string[];
  tools?: LanguageModelV4FunctionTool[];
  providerOptions?: OpenAICompatibleProviderOptions;
}

/**
 * Resolve one reasoning effort to its wire spelling for the exact model.
 * `off` (and a `null` wire spelling) means *omit the field* — the provider
 * default applies; every other declared effort sends its configured value.
 * An effort the model does not declare fails here, before any network I/O:
 * that is where a bad request-level effort AND a bad profile default both
 * belong (describing a model must never throw, but executing a request must).
 * @param model - the configured model descriptor, or `undefined` for an
 *   unlisted model id (which carries no reasoning declaration).
 * @param effort - the resolved effort to send, or `undefined` to send none.
 * @returns the wire `reasoning_effort` value, or `undefined` to omit the field.
 * @throws LlmError `UNSUPPORTED_REASONING_EFFORT` when the model does not
 *   declare the effort.
 */
export function resolveReasoningWire(
  model: ResolvedModelProfile | undefined,
  effort: ResolvedProviderProfile["reasoning"] | undefined,
): string | undefined {
  if (effort === void 0) return void 0;
  const declaration = model?.reasoningEfforts;
  if (declaration === void 0 || declaration === false) {
    const subject = model === void 0 ? "unlisted model" : `model "${model.id}"`;
    throw new LlmError(
      `OpenAI-compatible ${subject} declares no reasoning efforts, so "${effort}" cannot be selected`,
      "UNSUPPORTED_REASONING_EFFORT",
    );
  }
  const wire = declaration[effort];
  if (wire === void 0) {
    throw new LlmError(
      `OpenAI-compatible model "${model.id}" does not support reasoning effort "${effort}"`,
      "UNSUPPORTED_REASONING_EFFORT",
    );
  }
  if (wire === null) return void 0;
  return wire;
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      "The OpenAI-compatible chat-completions adapter does not support image content in this message.",
      "UNSUPPORTED_CONTENT",
    );
  }
}

/** Reject roles whose wire format cannot carry image input. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== "user" && contentHasImage(message.content)) {
      throw new LlmError(
        `The OpenAI-compatible chat-completions adapter cannot represent image content in a ${message.role} message.`,
        "UNSUPPORTED_CONTENT",
      );
    }
  }
}

/** Resolve one durable image into its transient data-URL file part. */
async function imagePart(
  block: Extract<ContentBlock, { type: "image" }>,
  attachments: AttachmentStore,
  signal?: AbortSignal,
): Promise<UserContentPart> {
  try {
    const stored = await attachments.readImage(block.attachment, signal);
    return {
      type: "file",
      mediaType: stored.ref.mediaType,
      data: {
        type: "url",
        url: new URL(
          `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`,
        ),
      },
    };
  } catch (error) {
    if (error instanceof AttachmentError)
      throw new LlmError(error.message, error.code, { cause: error });
    throw error;
  }
}

/** Serialize one assistant message into prompt parts, recording tool names by call id. */
function assistantParts(
  message: Message,
  toolNames: Map<string, string>,
): Extract<LanguageModelV4Prompt[number], { role: "assistant" }>["content"] {
  const parts: Extract<LanguageModelV4Prompt[number], { role: "assistant" }>["content"] = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        if (block.text.length > 0) parts.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        if (block.text.length > 0) parts.push({ type: "reasoning", text: block.text });
        break;
      case "tool-call": {
        let input: unknown;
        try {
          input = JSON.parse(block.arguments) as unknown;
        } catch {
          throw new LlmError(
            `assistant tool call "${block.id}" carries malformed JSON arguments`,
            "MALFORMED_RESPONSE",
          );
        }
        parts.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input });
        toolNames.set(block.id, block.name);
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

/** Convert user blocks into prompt parts, resolving images through the resolver. */
async function userParts(
  blocks: readonly ContentBlock[],
  resolveImage:
    | ((
        block: Extract<ContentBlock, { type: "image" }>,
        signal?: AbortSignal,
      ) => Promise<UserContentPart>)
    | undefined,
  signal?: AbortSignal,
): Promise<UserContentPart[]> {
  const parts: UserContentPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text.length > 0) parts.push({ type: "text", text: block.text });
        break;
      case "image":
        if (resolveImage === void 0)
          throw new LlmError(
            "The OpenAI-compatible chat-completions adapter does not support image content in this message.",
            "UNSUPPORTED_CONTENT",
          );
        parts.push(await resolveImage(block, signal));
        break;
      case "tool-result":
        parts.push(...(await userParts(block.content, resolveImage, signal)));
        break;
      default:
        break;
    }
  }
  return parts;
}

/**
 * Serialize the conversation into the AI SDK prompt. `tool-result` blocks
 * become standalone `{role: "tool"}` messages; the harness puts each tool
 * result in its own user-role message, so a mixed user message contributes
 * its text first and its tool results as separate wire messages after.
 * Tool-result images cannot ride a tool message, so they are buffered and
 * flushed into the next user message (or a dedicated one at the end).
 * @param messages - the harness conversation, in order.
 * @param resolveImage - image resolver for the image-capable path, or `undefined` for text-only.
 * @param signal - cancellation for attachment reads.
 * @returns the AI SDK prompt; order preserved.
 */
async function serializePrompt(
  messages: readonly Message[],
  resolveImage:
    | ((
        block: Extract<ContentBlock, { type: "image" }>,
        signal?: AbortSignal,
      ) => Promise<UserContentPart>)
    | undefined,
  signal?: AbortSignal,
): Promise<LanguageModelV4Prompt> {
  if (resolveImage === void 0) {
    for (const message of messages) assertTextOnly(message.content);
  } else {
    assertSupportedImageRoles(messages);
  }
  const prompt: LanguageModelV4Prompt = [];
  const toolNames = new Map<string, string>();
  let pendingToolImages: UserContentPart[] = [];
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    prompt.push({
      role: "user",
      content: [{ type: "text", text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    });
    pendingToolImages = [];
  };
  for (const message of messages) {
    if (message.role === "system") {
      flushToolImages();
      prompt.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      flushToolImages();
      const parts = assistantParts(message, toolNames);
      if (parts.length > 0) prompt.push({ role: "assistant", content: parts });
      continue;
    }
    const regular = message.content.filter((block) => block.type !== "tool-result");
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const content = await userParts(regular, resolveImage, signal);
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages();
      prompt.push({ role: "user", content });
    }
    for (const result of toolResults) {
      const images: UserContentPart[] = [];
      if (resolveImage !== void 0) {
        for (const block of result.content) {
          if (block.type === "image") images.push(await resolveImage(block, signal));
        }
      }
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: result.toolCallId,
            toolName: toolNames.get(result.toolCallId) ?? "",
            output: {
              type: "text",
              value:
                flattenText(result.content) ||
                (images.length > 0 ? "(see attached image)" : "(no output)"),
            },
          },
        ],
      });
      pendingToolImages.push(...images);
    }
  }
  flushToolImages();
  return prompt;
}

/** Serialize tool schemas to AI SDK function tools. */
function serializeTools(options: GenerateOptions): LanguageModelV4FunctionTool[] | undefined {
  const tools = options.tools?.map((tool): LanguageModelV4FunctionTool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as JSONSchema7,
  }));
  return tools !== void 0 && tools.length > 0 ? tools : void 0;
}

/** Merge profile sampling defaults under request-level values into call options. */
function callOptionsWithPrompt(
  options: GenerateOptions,
  profile: ResolvedProviderProfile,
  model: ResolvedModelProfile | undefined,
  prompt: LanguageModelV4Prompt,
): OpenAICompatibleCallOptions {
  const tools = serializeTools(options);
  const temperature = options.temperature ?? profile.temperature;
  const maxOutputTokens = options.maxTokens ?? model?.maxTokens ?? profile.defaultMaxTokens;
  const requestedEffort: ReasoningEffort | undefined =
    options.reasoningEffort === void 0
      ? profile.reasoning
      : (options.reasoningEffort as unknown as ReasoningEffort);
  const reasoningEffort = resolveReasoningWire(model, requestedEffort);
  const providerOptions: OpenAICompatibleProviderOptions = {
    "openai-compatible": {
      ...(reasoningEffort === void 0 ? {} : { reasoningEffort }),
      ...(profile.topK === void 0 ? {} : { top_k: profile.topK }),
    },
  };
  return {
    prompt,
    ...(temperature !== void 0 ? { temperature } : {}),
    ...(profile.topP !== void 0 ? { topP: profile.topP } : {}),
    ...(profile.presencePenalty !== void 0 ? { presencePenalty: profile.presencePenalty } : {}),
    ...(profile.frequencyPenalty !== void 0 ? { frequencyPenalty: profile.frequencyPenalty } : {}),
    ...(profile.seed !== void 0 ? { seed: profile.seed } : {}),
    ...(maxOutputTokens !== void 0 ? { maxOutputTokens } : {}),
    ...(options.stop !== void 0 ? { stopSequences: options.stop } : {}),
    ...(tools !== void 0 ? { tools } : {}),
    ...(Object.keys(providerOptions["openai-compatible"] ?? {}).length > 0
      ? { providerOptions }
      : {}),
  };
}

/**
 * Build the full call options for text-only content.
 * @param options - the harness request.
 * @param profile - resolved provider profile.
 * @param model - configured model descriptor, or `undefined` for unlisted ids.
 * @returns the AI SDK call options (settings + prompt + provider options).
 */
export async function serializeCallOptions(
  options: GenerateOptions,
  profile: ResolvedProviderProfile,
  model: ResolvedModelProfile | undefined,
): Promise<OpenAICompatibleCallOptions> {
  const system =
    options.system === void 0 ? [] : [{ role: "system" as const, content: options.system }];
  const prompt = await serializePrompt(options.messages, void 0);
  return callOptionsWithPrompt(options, profile, model, [...system, ...prompt]);
}

/**
 * Build one image-capable request while keeping durable bytes out of session
 * messages. Oversized oldest images become deterministic text before any
 * attachment read.
 * @param options - the harness request containing image-capable user content.
 * @param profile - resolved provider profile.
 * @param model - configured model descriptor, or `undefined` for unlisted ids.
 * @param images - the attachment resolver, request bound, and cancellation.
 * @returns the fully materialized call options.
 */
export async function serializeCallOptionsWithImages(
  options: GenerateOptions,
  profile: ResolvedProviderProfile,
  model: ResolvedModelProfile | undefined,
  images: { attachments: AttachmentStore; maxRequestImageBytes: number; signal?: AbortSignal },
): Promise<OpenAICompatibleCallOptions> {
  const requestMessages = offloadRequestImagesWithPolicy(options.messages, {
    representation: "raw",
    maxBytes: images.maxRequestImageBytes,
    placeholder: (ref) => textOnlyImageText(ref),
  });
  const resolveImage = (block: Extract<ContentBlock, { type: "image" }>, signal?: AbortSignal) =>
    imagePart(block, images.attachments, signal);
  const system =
    options.system === void 0 ? [] : [{ role: "system" as const, content: options.system }];
  const prompt = await serializePrompt(requestMessages, resolveImage, images.signal);
  return callOptionsWithPrompt(options, profile, model, [...system, ...prompt]);
}
