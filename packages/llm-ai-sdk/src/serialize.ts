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

const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";

type UserContentPart = Extract<LanguageModelV4Prompt[number], { role: "user" }>["content"][number];

export type LlmAiSdkProviderOptions = SharedV4ProviderOptions & {
  "openai-compatible"?: {
    reasoningEffort?: string;

    top_k?: number;
  };
  openai?: {
    reasoningEffort?: string;
  };
  "open-responses"?: {
    reasoningEffort?: string;
  };
};

export interface LlmAiSdkCallOptions {
  prompt: LanguageModelV4Prompt;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: string[];
  tools?: LanguageModelV4FunctionTool[];
  providerOptions?: LlmAiSdkProviderOptions;
}

export function resolveReasoningWire(
  model: ResolvedModelProfile | undefined,
  effort: ResolvedProviderProfile["reasoning"] | undefined,
): string | undefined {
  if (effort === void 0) return void 0;
  const declaration = model?.reasoningEfforts;
  if (declaration === void 0 || declaration === false) {
    const subject = model === void 0 ? "unlisted model" : `model "${model.id}"`;
    throw new LlmError(
      `llm-ai-sdk ${subject} declares no reasoning efforts, so "${effort}" cannot be selected`,
      "UNSUPPORTED_REASONING_EFFORT",
    );
  }
  const wire = declaration[effort];
  if (wire === void 0) {
    throw new LlmError(
      `llm-ai-sdk model "${model.id}" does not support reasoning effort "${effort}"`,
      "UNSUPPORTED_REASONING_EFFORT",
    );
  }
  if (wire === null) return void 0;
  return wire;
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      "The llm-ai-sdk chat-completions adapter does not support image content in this message.",
      "UNSUPPORTED_CONTENT",
    );
  }
}

function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== "user" && contentHasImage(message.content)) {
      throw new LlmError(
        `The llm-ai-sdk chat-completions adapter cannot represent image content in a ${message.role} message.`,
        "UNSUPPORTED_CONTENT",
      );
    }
  }
}

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
            "The llm-ai-sdk chat-completions adapter does not support image content in this message.",
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

function serializeTools(options: GenerateOptions): LanguageModelV4FunctionTool[] | undefined {
  const tools = options.tools?.map((tool): LanguageModelV4FunctionTool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as JSONSchema7,
  }));
  return tools !== void 0 && tools.length > 0 ? tools : void 0;
}

function providerOptionsFor(
  api: ResolvedProviderProfile["api"],
  reasoningEffort: string | undefined,
  topK: number | undefined,
): LlmAiSdkProviderOptions | undefined {
  // 官方 openai 与独立 open-responses 后端丢弃 top_k（只在 stream-start 里
  // 发 unsupported warning），不发送它；openai-compatible 网关透传 top_k。
  // reasoning_effort 三个后端都在各自的 providerOptions key 下直通（任意
  // wire 拼写均不校验），所以档位 wire 照发。
  switch (api) {
    case "openai-compatible":
      return reasoningEffort === void 0 && topK === void 0
        ? void 0
        : {
          "openai-compatible": {
            ...(reasoningEffort === void 0 ? {} : { reasoningEffort }),
            ...(topK === void 0 ? {} : { top_k: topK }),
          },
        };
    case "openai":
      return reasoningEffort === void 0
        ? void 0
        : { openai: { reasoningEffort } };
    case "open-responses":
      return reasoningEffort === void 0
        ? void 0
        : { "open-responses": { reasoningEffort } };
  }
}

function callOptionsWithPrompt(
  options: GenerateOptions,
  profile: ResolvedProviderProfile,
  model: ResolvedModelProfile | undefined,
  prompt: LanguageModelV4Prompt,
): LlmAiSdkCallOptions {
  const tools = serializeTools(options);
  const temperature = options.temperature ?? profile.temperature;
  const maxOutputTokens = options.maxTokens ?? model?.maxTokens ?? profile.defaultMaxTokens;
  const requestedEffort: ReasoningEffort | undefined =
    options.reasoningEffort === void 0
      ? profile.reasoning
      : (options.reasoningEffort as unknown as ReasoningEffort);
  const reasoningEffort = resolveReasoningWire(model, requestedEffort);
  const providerOptions = providerOptionsFor(profile.api, reasoningEffort, profile.topK);
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
    ...(providerOptions === void 0 ? {} : { providerOptions }),
  };
}

export async function serializeCallOptions(
  options: GenerateOptions,
  profile: ResolvedProviderProfile,
  model: ResolvedModelProfile | undefined,
): Promise<LlmAiSdkCallOptions> {
  const system =
    options.system === void 0 ? [] : [{ role: "system" as const, content: options.system }];
  const prompt = await serializePrompt(options.messages, void 0);
  return callOptionsWithPrompt(options, profile, model, [...system, ...prompt]);
}

export async function serializeCallOptionsWithImages(
  options: GenerateOptions,
  profile: ResolvedProviderProfile,
  model: ResolvedModelProfile | undefined,
  images: { attachments: AttachmentStore; maxRequestImageBytes: number; signal?: AbortSignal },
): Promise<LlmAiSdkCallOptions> {
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
