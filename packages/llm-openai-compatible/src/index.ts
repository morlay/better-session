/**
 * Register a {@link OpenAICompatibleAdapter} for every route in the plugin's
 * `providers` dict on `ctx.llm`. Profile facts resolve per request over the
 * optional `llm-openai-compatible` user-settings section (`ctx.settings`), so
 * a changed base URL, catalog, sampling default, or key reaches the very next
 * request without restarting anything, while an in-flight stream keeps the
 * facts it started with. A changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place, and the configurable-provider directory tracks the declared
 * routes so configuration surfaces can show and edit each profile.
 * @module @morlay/dsh-llm-openai-compatible
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  LlmError,
  RetryPolicySchema,
  assertUsableApiKey,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import type { ModelModality, RetryPolicyConfig } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OpenAICompatibleAdapter,
} from "./adapter.ts";
import type { ReasoningEffort, ResolvedModelProfile, ResolvedProviderProfile } from "./adapter.ts";

export { OpenAICompatibleAdapter } from "./adapter.ts";
export type {
  OpenAICompatibleAdapterOptions,
  ReasoningEffort,
  ResolvedModelProfile,
  ResolvedProviderProfile,
} from "./adapter.ts";
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from "./adapter.ts";

export const name = "llm-openai-compatible";
export const inject = ["llm"];
export const NS = "llm-openai-compatible";

/** Selectable reasoning levels a profile or model may declare. */
export const REASONING_LEVELS = ["off", "low", "high", "max"] as const;
/** Accepted model input modalities. */
export const MODEL_MODALITIES = ["text", "image"] as const;

/** Source shape of one model catalog entry. */
export interface ModelProfileSource {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: ModelModality[];
  reasoningEfforts?: false | Partial<Record<ReasoningEffort, string | null>>;
}

/** Source shape of one provider route profile; the `providers` dict key IS the route. */
export interface ProviderProfileSource {
  /** Credential reference (environment-variable name); absence sends no authorization header. */
  apiKeyEnv?: string;
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string;
  /** Required endpoint base; requests hit `${baseURL}/chat/completions`. */
  baseURL: string;
  /** Extra request headers, merged under the mandatory attribution headers. */
  headers?: Record<string, string>;
  // === sampling defaults (request-level values win) ===
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  /** Deployment default reasoning level; omission keeps the provider default. */
  reasoning?: ReasoningEffort;
  /** This route's model catalog; omission serves an empty catalog (unlisted ids pass through). */
  models?: ModelProfileSource[];
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  maxRequestImageBytes?: number;
  streamIdleTimeoutMs?: number;
  /** Whole-request deadline in milliseconds; unset arms no overall timer. */
  timeoutMs?: number;
  retryPolicy?: RetryPolicyConfig;
}

/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /** Provider routes, keyed by route. An empty (or omitted) dict is the dormant posture. */
  providers?: Record<string, ProviderProfileSource>;
}

const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"]),
  reasoningEfforts: z.union([z.const(false), z.dict(z.union([z.string(), z.const(null)]))]),
});

const providerSchema = z.object({
  apiKeyEnv: z.string().role("credential-ref"),
  displayName: z.string(),
  baseURL: z.string().required(),
  headers: z.dict(z.string()),
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  topK: z.number().step(1).min(1),
  presencePenalty: z.number().min(-2).max(2),
  frequencyPenalty: z.number().min(-2).max(2),
  seed: z.number().step(1).min(1),
  reasoning: z.union(REASONING_LEVELS),
  models: z.array(modelSchema),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  streamIdleTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  timeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
  retryPolicy: RetryPolicySchema,
});

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  providers: z.dict(providerSchema).default({}),
});

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

/** Validate one model's declared reasoning efforts into detached form. */
function resolveReasoningEfforts(
  provider: string,
  modelId: string,
  value: ModelProfileSource["reasoningEfforts"],
): Pick<ResolvedModelProfile, "reasoningEfforts"> {
  if (value === void 0) return {};
  if (value === false) return { reasoningEfforts: false };
  const declaration: Partial<Record<ReasoningEffort, string | null>> = {};
  for (const [effort, wire] of Object.entries(value)) {
    if (!isReasoningEffort(effort)) {
      throw new Error(
        `llm-openai-compatible: provider "${provider}" model "${modelId}" declares unknown reasoning effort "${effort}"`,
      );
    }
    if (effort === "off") {
      if (wire !== null) {
        throw new Error(
          `llm-openai-compatible: provider "${provider}" model "${modelId}" reasoning effort "off" must leave an empty wire spelling (null) to omit reasoning_effort`,
        );
      }
      declaration.off = null;
      continue;
    }
    if (wire === null || wire.length === 0) {
      throw new Error(
        `llm-openai-compatible: provider "${provider}" model "${modelId}" reasoning effort "${effort}" needs a non-empty wire spelling`,
      );
    }
    declaration[effort] = wire;
  }
  return { reasoningEfforts: declaration };
}

/** Validate and detach one provider route's model catalog. */
function resolveModels(
  provider: string,
  models: readonly ModelProfileSource[] | undefined,
): readonly ResolvedModelProfile[] {
  if (models === void 0) return [];
  const seen = new Set<string>();
  return models.map((model) => {
    if (model.id.length === 0)
      throw new Error(
        `llm-openai-compatible: provider "${provider}" catalog model ids must be non-empty`,
      );
    if (model.name !== void 0 && model.name.length === 0)
      throw new Error(
        `llm-openai-compatible: provider "${provider}" catalog model "${model.id}" has an empty name`,
      );
    if (
      model.contextWindow !== void 0 &&
      (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)
    ) {
      throw new Error(
        `llm-openai-compatible: provider "${provider}" catalog model "${model.id}" contextWindow must be a positive integer`,
      );
    }
    if (
      model.maxTokens !== void 0 &&
      (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)
    ) {
      throw new Error(
        `llm-openai-compatible: provider "${provider}" catalog model "${model.id}" maxTokens must be a positive integer`,
      );
    }
    const inputModalities = model.inputModalities ?? ["text"];
    if (inputModalities.length === 0)
      throw new Error(
        `llm-openai-compatible: provider "${provider}" catalog model "${model.id}" inputModalities must not be empty`,
      );
    if (
      inputModalities.some(
        (modality) => !(MODEL_MODALITIES as readonly string[]).includes(modality),
      )
    ) {
      throw new Error(
        `llm-openai-compatible: provider "${provider}" catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
      );
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(
        `llm-openai-compatible: provider "${provider}" catalog model "${model.id}" inputModalities must not contain duplicates`,
      );
    }
    if (seen.has(model.id))
      throw new Error(
        `llm-openai-compatible: provider "${provider}" has duplicate catalog model "${model.id}"`,
      );
    seen.add(model.id);
    return {
      id: model.id,
      ...(model.name === void 0 ? {} : { name: model.name }),
      ...(model.description === void 0 ? {} : { description: model.description }),
      ...(model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }),
      inputModalities: [...inputModalities],
      ...resolveReasoningEfforts(provider, model.id, model.reasoningEfforts),
    };
  });
}

/** A bounded finite number within `[lo, hi]`, or undefined. */
function bounded(value: number | undefined, lo: number, hi: number): number | undefined {
  if (value === void 0) return void 0;
  if (!Number.isFinite(value) || value < lo || value > hi) return void 0;
  return value;
}

/**
 * The one explicit resolve step from a raw profile to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param provider - the route key owning this profile.
 * @param source - raw profile from config or a resolved settings snapshot.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(
  provider: string,
  source: ProviderProfileSource,
): ResolvedProviderProfile {
  if (provider.length === 0)
    throw new Error("llm-openai-compatible: provider names must be non-empty");
  if (source.baseURL === void 0 || source.baseURL.length === 0) {
    throw new Error(`llm-openai-compatible: provider "${provider}" requires a non-empty baseURL`);
  }
  if (source.displayName !== void 0 && source.displayName.length === 0) {
    throw new Error(`llm-openai-compatible: provider "${provider}" has an empty displayName`);
  }
  const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (
    !Number.isFinite(streamIdleTimeoutMs) ||
    streamIdleTimeoutMs <= 0 ||
    streamIdleTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES;
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" maxRequestImageBytes must be a positive safe integer`,
    );
  }
  const defaultContextWindow = source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" defaultContextWindow must be a positive integer`,
    );
  }
  const defaultMaxTokens = source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" defaultMaxTokens must be a positive safe integer`,
    );
  }
  const timeoutMs = bounded(source.timeoutMs, Number.MIN_VALUE, MAX_TIMER_DELAY_MS);
  if (source.timeoutMs !== void 0 && timeoutMs === void 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  if (bounded(source.temperature, 0, 2) === void 0 && source.temperature !== void 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" temperature must be a finite number within 0..2`,
    );
  }
  if (bounded(source.topP, 0, 1) === void 0 && source.topP !== void 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" topP must be a finite number within 0..1`,
    );
  }
  if (source.topK !== void 0 && (!Number.isInteger(source.topK) || source.topK <= 0)) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" topK must be a positive integer`,
    );
  }
  if (bounded(source.presencePenalty, -2, 2) === void 0 && source.presencePenalty !== void 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" presencePenalty must be a finite number within -2..2`,
    );
  }
  if (bounded(source.frequencyPenalty, -2, 2) === void 0 && source.frequencyPenalty !== void 0) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" frequencyPenalty must be a finite number within -2..2`,
    );
  }
  if (source.seed !== void 0 && (!Number.isInteger(source.seed) || source.seed <= 0)) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" seed must be a positive integer`,
    );
  }
  if (source.reasoning !== void 0 && !isReasoningEffort(source.reasoning)) {
    throw new Error(
      `llm-openai-compatible: provider "${provider}" reasoning must be one of ${REASONING_LEVELS.join(", ")}`,
    );
  }
  return {
    provider,
    displayName: source.displayName ?? provider,
    ...(source.apiKeyEnv === void 0 ? {} : { apiKeyEnv: credentialRef(source.apiKeyEnv) }),
    baseURL: source.baseURL,
    ...(source.headers === void 0 ? {} : { headers: { ...source.headers } }),
    ...(source.temperature === void 0 ? {} : { temperature: source.temperature }),
    ...(source.topP === void 0 ? {} : { topP: source.topP }),
    ...(source.topK === void 0 ? {} : { topK: source.topK }),
    ...(source.presencePenalty === void 0 ? {} : { presencePenalty: source.presencePenalty }),
    ...(source.frequencyPenalty === void 0 ? {} : { frequencyPenalty: source.frequencyPenalty }),
    ...(source.seed === void 0 ? {} : { seed: source.seed }),
    ...(source.reasoning === void 0 ? {} : { reasoning: source.reasoning }),
    models: resolveModels(provider, source.models),
    defaultContextWindow,
    defaultMaxTokens,
    maxRequestImageBytes,
    streamIdleTimeoutMs,
    ...(timeoutMs === void 0 ? {} : { timeoutMs }),
    retryPolicy: resolveRetryPolicy(
      source.retryPolicy,
      `llm-openai-compatible: provider "${provider}" retryPolicy`,
    ),
  };
}

/**
 * Validate profiles and return a detached route-keyed map suitable for
 * per-request reads. This is the one explicit resolve step, so an omitted dict
 * resolves to the empty (dormant) route set here rather than through a hidden
 * fallback.
 * @param providers - configured provider profiles keyed by route.
 * @returns validated profiles in configuration order.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, ProviderProfileSource>> | undefined,
): Map<string, ResolvedProviderProfile> {
  if (Array.isArray(providers))
    throw new Error(
      "llm-openai-compatible: providers is now a dict keyed by provider route, not an array of profiles",
    );
  const resolved = new Map<string, ResolvedProviderProfile>();
  for (const [provider, source] of Object.entries(providers ?? {})) {
    resolved.set(provider, resolveAdapterOptions(provider, source));
  }
  return resolved;
}

/**
 * Reject a section this adapter could not serve. Registered as the settings
 * namespace's validator, so an unserviceable profile is refused where it is
 * written instead of being stored and then quietly disabling every route in
 * the namespace.
 * @param config - the resolved section to check.
 */
export function assertServiceable(config: Config): void {
  resolveProfiles(config.providers);
}

/** The registry captures these per route; a change here must re-register. */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedProviderProfile>): unknown[] {
  return [...profiles.entries()]
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

/**
 * The configurable-provider directory: every route the current profiles
 * declare. A hand-declared route has no catalog entry, so without this it
 * would have no settings address and configuration surfaces could neither
 * show nor edit it. The profile half is unconditional, which keeps a route
 * already stored against a withheld provider editable and deletable.
 */
function directoryEntries(profiles: ReadonlyMap<string, ResolvedProviderProfile>): {
  provider: string;
  displayName: string;
  settingsNs: typeof NS;
  settingsPath: readonly string[];
  declared: boolean;
}[] {
  const entries = new Map<
    string,
    {
      provider: string;
      displayName: string;
      settingsNs: typeof NS;
      settingsPath: readonly string[];
      declared: boolean;
    }
  >();
  for (const [provider, profile] of profiles) {
    entries.set(provider, {
      provider,
      displayName: profile.displayName,
      settingsNs: NS,
      settingsPath: ["providers", provider],
      declared: true,
    });
  }
  return [...entries.values()];
}

/** Register one generic OpenAI-compatible adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  let current = () => config;
  let lastRaw: Config | undefined;
  let memoized: Map<string, ResolvedProviderProfile> | undefined;
  /** The resolved profiles for the current configuration, memoized by raw identity. */
  const profiles = (): ReadonlyMap<string, ResolvedProviderProfile> => {
    const raw = current();
    if (raw === lastRaw && memoized !== void 0) return memoized;
    const next = resolveProfiles(raw.providers);
    lastRaw = raw;
    memoized = next;
    return next;
  };
  profiles();
  const resolveApiKey = async (
    provider: string,
    profile: ResolvedProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv;
    if (ref === void 0) return void 0;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-openai-compatible", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== void 0 && ambient.value.length > 0)
        return assertUsableApiKey(ambient.value, "llm-openai-compatible", ref);
    }
    throw new LlmError(
      `llm-openai-compatible: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      "MISSING_CREDENTIAL",
    );
  };
  let userId: string | undefined;
  const resolveUserId = () => (userId ??= getOrCreateAnonymousUserId());
  const adapter = new OpenAICompatibleAdapter({
    profiles,
    resolveApiKey,
    resolveUserId,
    resolveAttachments: () => ctx.get("attachments"),
  });
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined;
  let directoryFacts: unknown[] | undefined;
  const ensureDirectory = () => {
    const entries = directoryEntries(profiles());
    if (deepEqualJson(entries, directoryFacts)) return;
    if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
    else directory.replace(entries);
    directoryFacts = entries;
  };
  ensureDirectory();
  let registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined;
  let registeredFacts: unknown[] | undefined;
  const ensureRegistrationFacts = () => {
    const facts = registrationFacts(profiles());
    if (deepEqualJson(facts, registeredFacts)) return;
    const routes = [...profiles().keys()];
    if (registration === void 0) {
      if (routes.length === 0) {
        registeredFacts = facts;
        return;
      }
      registration = ctx.llm.registerAdapter(routes, adapter);
    } else {
      registration.replace(routes);
    }
    registeredFacts = facts;
  };
  ensureRegistrationFacts();
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      validate: assertServiceable,
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
        try {
          ensureRegistrationFacts();
        } catch (error) {
          ctx.logger.error(
            "llm-openai-compatible: keeping the previously registered routes after a refused update",
          );
          ctx.logger.error(error);
        }
        try {
          ensureDirectory();
        } catch (error) {
          ctx.logger.error(
            "llm-openai-compatible: keeping the previous configurable-provider directory after a refused update",
          );
          ctx.logger.error(error);
        }
      },
    });
  });
}
