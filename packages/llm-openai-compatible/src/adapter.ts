/**
 * `OpenAICompatibleAdapter`: a multi-provider harness adapter built on
 * `@ai-sdk/openai-compatible`. One instance serves every provider route in
 * the plugin's `providers` dict; profile facts arrive through a thunk resolved
 * once per operation, so the registering plugin owns validation, layering, and
 * credential policy, and a changed profile reaches the next request without a
 * restart. The SDK owns wire serialization and SSE parsing; this adapter owns
 * harness message conversion, sampling-default merging (via
 * `serialize.ts`), chunk translation (via `translate.ts`), and error
 * normalization.
 * @module dsh-llm-openai-compatible/adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { deadline, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { serializeCallOptions, serializeCallOptionsWithImages } from "./serialize.ts";
import { translate } from "./translate.ts";

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default combined request/response context capacity for unconfigured models. */
export const DEFAULT_CONTEXT_WINDOW = 262_144;
/** Default per-request output-token cap for unconfigured models. */
export const DEFAULT_MAX_TOKENS = 32_768;
/** Default bound on accumulated base64 image payload per request. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** Code stamped on the idle-watchdog timeout reason. */
export const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** Code stamped on the whole-request deadline timeout reason. */
export const REQUEST_TIMEOUT_CODE = "LLM_REQUEST_TIMEOUT";
/** The provider options key the SDK forwards into the request body. */
export const PROVIDER_OPTIONS_KEY = "openai-compatible";

/** Selectable reasoning effort levels for one provider route. */
export type ReasoningEffort = "off" | "low" | "high" | "max";

/** One validated catalog model of a provider route. */
export interface ResolvedModelProfile {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities: readonly ModelModality[];
  /**
   * Declared reasoning efforts: key = selectable level, value = wire
   * `reasoning_effort` spelling. `false` rejects the capability outright;
   * absent means the model carries no reasoning metadata. A `null` wire
   * spelling (only legal for `off`) means "omit the field".
   */
  reasoningEfforts?: false | Partial<Record<ReasoningEffort, string | null>>;
}

/** One validated provider route profile, detached and ready for per-request reads. */
export interface ResolvedProviderProfile {
  provider: string;
  displayName: string;
  /** Credential reference; absence means the route sends no authorization header. */
  apiKeyEnv?: CredentialRef;
  /** Required endpoint base; requests hit `${baseURL}/chat/completions`. */
  baseURL: string;
  headers?: Readonly<Record<string, string>>;
  // === sampling defaults (request-level values win) ===
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  /** Deployment default reasoning level; omission keeps the provider default. */
  reasoning?: ReasoningEffort;
  // === model catalog ===
  models: readonly ResolvedModelProfile[];
  defaultContextWindow: number;
  defaultMaxTokens: number;
  // === transport ===
  maxRequestImageBytes: number;
  streamIdleTimeoutMs: number;
  /** Whole-request deadline in milliseconds; unset arms no overall timer. */
  timeoutMs?: number;
  retryPolicy: ResolvedRetryPolicy;
}

/** Constructor options for {@link OpenAICompatibleAdapter}: the hooks the plugin owns. */
export interface OpenAICompatibleAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedProviderProfile>;
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` means the route sends no
   * authorization header (an unauthenticated endpoint such as local Ollama).
   */
  resolveApiKey: (
    provider: string,
    profile: ResolvedProviderProfile,
  ) => Promise<string | undefined>;
  /** Resolve the harness anonymous user id for request attribution headers. */
  resolveUserId: () => string;
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined;
}

/** The wire usage shape the SDK converter receives (subset of the OpenAI shape). */
interface WireUsageLike {
  prompt_tokens?: number | null | undefined;
  completion_tokens?: number | null | undefined;
  prompt_tokens_details?: { cached_tokens?: number | null | undefined } | null | undefined;
  /** DeepSeek-dialect cache hits folded into prompt_tokens. */
  prompt_cache_hit_tokens?: number | null | undefined;
  completion_tokens_details?: { reasoning_tokens?: number | null | undefined } | null | undefined;
}

/**
 * Convert provider token accounting into disjoint AI SDK usage. OpenAI's
 * `prompt_tokens_details.cached_tokens` and the DeepSeek dialect's
 * `prompt_cache_hit_tokens` both report cache reads folded into
 * `prompt_tokens`; the harness convention is disjoint counts, so cache reads
 * are split out regardless of which field the endpoint used.
 */
export function convertUsage(usage: WireUsageLike | null | undefined): LanguageModelV4Usage {
  if (usage == null) {
    return {
      inputTokens: { total: 0, noCache: 0, cacheRead: void 0, cacheWrite: void 0 },
      outputTokens: { total: 0, text: void 0, reasoning: void 0 },
    };
  }
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cacheRead =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: Math.max(0, promptTokens - cacheRead),
      cacheRead,
      cacheWrite: void 0,
    },
    outputTokens: {
      total: completionTokens,
      text: Math.max(0, completionTokens - reasoningTokens),
      reasoning: reasoningTokens,
    },
  };
}

/** The first real blocks of one resolve: display + catalog metadata. */
function modelInfo(profile: ResolvedProviderProfile, model: ResolvedModelProfile): LlmModelInfo {
  return {
    provider: profile.provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === void 0 ? {} : { description: model.description }),
    inputModalities: [...model.inputModalities],
  };
}

/** The harness reasoning info for one model, honoring its declared efforts. */
function reasoningInfo(
  model: ResolvedModelProfile | undefined,
  defaultEffort: ReasoningEffort | undefined,
): Pick<LlmResolvedModelInfo, "reasoning"> {
  const declaration = model?.reasoningEfforts;
  if (declaration === void 0 || declaration === false) return {};
  const entries = Object.entries(declaration) as [ReasoningEffort, string | null | undefined][];
  const efforts = entries.map(([id]) => ({
    id: ReasoningEffortId(id),
    name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
  }));
  return {
    reasoning: {
      efforts,
      // A configured default the model does not declare is silently dropped
      // here (describing a model must never throw); the request path still
      // refuses it, which is where a bad deployment default belongs.
      ...(defaultEffort !== void 0 && declaration[defaultEffort] !== void 0
        ? { defaultEffort: ReasoningEffortId(defaultEffort) }
        : {}),
    },
  };
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(
  status: number,
  error?: { code?: unknown; type?: unknown; message?: unknown },
): string {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 413) return "INVALID_REQUEST";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/** Parse a provider error body out of an API-call error's JSON response body. */
function providerErrorBody(
  error: APICallError,
): { code?: unknown; type?: unknown; message?: unknown } | undefined {
  if (error.responseBody === void 0) return void 0;
  try {
    const parsed = JSON.parse(error.responseBody) as {
      error?: { code?: unknown; type?: unknown; message?: unknown };
    };
    return parsed.error;
  } catch {
    return void 0;
  }
}

/** Extract a provider-issued request id from response headers when present. */
function requestId(headers: Record<string, string> | undefined): ProviderRequestId | undefined {
  if (headers === void 0) return void 0;
  const value = headers["x-request-id"] ?? headers["x-openai-compatible-request-id"];
  return value === void 0 || value.length === 0 ? void 0 : ProviderRequestId(value);
}

/**
 * Multi-provider adapter. Each operation reads the current profiles, so a
 * configuration change reaches the next request without a restart; the
 * underlying SDK provider instance is cached per resolved profile and rebuilt
 * when the profile object changes.
 */
export class OpenAICompatibleAdapter extends LlmAdapter {
  private readonly config: OpenAICompatibleAdapterOptions;
  private readonly sdkProviders = new Map<ResolvedProviderProfile, Map<string, LanguageModelV4>>();

  constructor(config: OpenAICompatibleAdapterOptions) {
    super();
    this.config = config;
  }

  /** The profile for one route, or the not-owned failure. */
  private profileOf(provider: string): ResolvedProviderProfile {
    const profile = this.config.profiles().get(provider);
    if (profile === void 0)
      throw new LlmError(
        `OpenAI-compatible adapter does not own provider "${provider}"`,
        "NO_ADAPTER",
      );
    return profile;
  }

  /** The configured descriptor for one exact route/model pair; unlisted ids pass through. */
  private modelOf(
    profile: ResolvedProviderProfile,
    model: string,
  ): ResolvedModelProfile | undefined {
    return profile.models.find((entry) => entry.id === model);
  }

  /** The SDK chat model for one route/model, cached per resolved profile. */
  private sdkModel(profile: ResolvedProviderProfile, modelId: string): LanguageModelV4 {
    let byModel = this.sdkProviders.get(profile);
    if (byModel === void 0) {
      byModel = new Map();
      this.sdkProviders.set(profile, byModel);
    }
    let model = byModel.get(modelId);
    if (model === void 0) {
      const provider = createOpenAICompatible({
        name: PROVIDER_OPTIONS_KEY,
        baseURL: profile.baseURL,
        headers: { ...profile.headers, ...attributionHeaders() },
        includeUsage: true,
        convertUsage,
      });
      model = provider.chatModel(modelId);
      byModel.set(modelId, model);
    }
    return model;
  }

  providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: this.config.profiles().get(provider)?.displayName ?? provider,
    };
  }

  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.config.profiles().get(provider)?.retryPolicy;
  }

  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profileOf(provider);
    return Promise.resolve(profile.models.map((model) => modelInfo(profile, model)));
  }

  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const profile = this.profileOf(provider);
    const configured = this.modelOf(profile, model);
    const contextWindow = configured?.contextWindow ?? profile.defaultContextWindow;
    const maxTokens = configured?.maxTokens ?? profile.defaultMaxTokens;
    return Promise.resolve({
      ...(configured === void 0
        ? { provider, id: model, name: model, inputModalities: ["text" as const] }
        : modelInfo(profile, configured)),
      context: { contextWindow },
      ...(maxTokens !== void 0 ? { defaultMaxTokens: maxTokens } : {}),
      ...reasoningInfo(configured, profile.reasoning),
    });
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const profile = this.profileOf(options.provider);
    const model = this.modelOf(profile, options.model);
    const hasImages = options.messages.some((message) => contentHasImage(message.content));
    let attachments: AttachmentStore | undefined;
    if (hasImages) {
      if (model?.inputModalities.includes("image") !== true) {
        throw new LlmError(
          `OpenAI-compatible model "${options.model}" does not accept image input.`,
          "UNSUPPORTED_CONTENT",
        );
      }
      attachments = this.config.resolveAttachments?.();
      if (attachments === void 0)
        throw new LlmError(
          "OpenAI-compatible image conversion requires the durable attachment service.",
          "UNSUPPORTED_CONTENT",
        );
    }
    const apiKey = await this.config.resolveApiKey(options.provider, profile);
    const userId = this.config.resolveUserId();
    const consumer = new AbortController();
    const upstream =
      options.signal === void 0
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal]);
    const overall =
      profile.timeoutMs === void 0
        ? void 0
        : deadline(upstream, profile.timeoutMs, REQUEST_TIMEOUT_CODE);
    const watchdog = idleWatchdog(
      overall?.signal ?? upstream,
      profile.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    );
    try {
      const callOptions =
        attachments === void 0
          ? await serializeCallOptions(options, profile, model)
          : await serializeCallOptionsWithImages(options, profile, model, {
              attachments,
              maxRequestImageBytes: profile.maxRequestImageBytes,
              signal: watchdog.signal,
            });
      const sdkModel = this.sdkModel(profile, options.model);
      let result;
      try {
        result = await sdkModel.doStream({
          ...callOptions,
          abortSignal: watchdog.signal,
          headers: {
            ...(apiKey === void 0 ? {} : { authorization: `Bearer ${apiKey}` }),
            "x-openai-compatible-harness-user-id": String(userId),
            ...(options.sessionId !== void 0
              ? { "x-openai-compatible-harness-session-id": String(options.sessionId) }
              : {}),
            ...(options.purpose === "compaction"
              ? { "x-openai-compatible-harness-compact": "1" }
              : {}),
          },
        });
      } catch (error) {
        throw this.normalizeTransportError(error, profile);
      }
      const iterator = translate(result.stream)[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const next = await watchdog.next(iterator);
          if (next.done) {
            exhausted = true;
            return;
          }
          yield next.value;
        }
      } catch (error) {
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) {
          throw new LlmError(
            `OpenAI-compatible stream idle timeout after ${profile.streamIdleTimeoutMs}ms`,
            "TIMEOUT",
            { cause: error },
          );
        }
        if (
          profile.timeoutMs !== void 0 &&
          timeoutOf(watchdog.signal, REQUEST_TIMEOUT_CODE) !== void 0
        ) {
          throw new LlmError(
            `OpenAI-compatible request timeout after ${profile.timeoutMs}ms`,
            "TIMEOUT",
            { cause: error },
          );
        }
        if (options.signal?.aborted)
          throw new LlmError("OpenAI-compatible request aborted by caller", "ABORTED", {
            cause: error,
          });
        if (error instanceof LlmError) throw error;
        throw this.normalizeTransportError(error, profile);
      } finally {
        consumer.abort("OpenAI-compatible stream consumer stopped");
        if (!exhausted) {
          try {
            await iterator.return(void 0);
          } catch {
            // The transport already aborted; teardown is best-effort.
          }
        }
      }
    } finally {
      watchdog[Symbol.dispose]();
      overall?.[Symbol.dispose]();
    }
  }

  /** Normalize an SDK/transport failure into a harness LlmError. */
  private normalizeTransportError(error: unknown, profile: ResolvedProviderProfile): LlmError {
    if (error instanceof LlmError) return error;
    if (APICallError.isInstance(error)) {
      const providerError = providerErrorBody(error);
      const message =
        typeof providerError?.message === "string" ? providerError.message : error.message;
      const id = requestId(error.responseHeaders);
      return new LlmError(message, httpErrorCode(error.statusCode ?? 0, providerError), {
        ...(error.statusCode === void 0 ? {} : { status: error.statusCode }),
        ...(id === void 0 ? {} : { requestId: id }),
        cause: error,
      });
    }
    if (error instanceof Error) {
      return new LlmError(
        `OpenAI-compatible API request to ${profile.baseURL} failed`,
        "TRANSPORT",
        { cause: error },
      );
    }
    return new LlmError(`OpenAI-compatible API request to ${profile.baseURL} failed`, "TRANSPORT");
  }
}
