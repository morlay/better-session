// 传输层选型：按 profile 的 api 风格选择 AI SDK 提供方。三种后端都实现
// 同一个 LanguageModelV4 接口（serialize / translate 对三者共用），这里只
// 负责建 SDK 工厂/取模型面，以及风格相关的工厂参数差异。

import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenResponses } from "@ai-sdk/open-responses";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import type { ResolvedProviderProfile } from "./adapter.ts";
import { convertUsage, PROVIDER_OPTIONS_KEY } from "./adapter.ts";

/** 本插件支持的 AI SDK 传输风格（profile 级 `api` 字段）。 */
export const LLM_APIS = ["openai-compatible", "openai", "open-responses"] as const;

export type LlmApi = (typeof LLM_APIS)[number];

/** 风格缺省：向后兼容既有配置（未声明 api 的 profile 走 openai-compatible）。 */
export const DEFAULT_LLM_API: LlmApi = "openai-compatible";

/** 风格的人类可读名（配置界面下拉）。 */
export function apiDisplayName(api: LlmApi): string {
  switch (api) {
    case "openai-compatible":
      return "OpenAI Compatible (chat)";
    case "openai":
      return "OpenAI (chat)";
    case "open-responses":
      return "OpenAI Responses";
  }
}

/**
 * 构造/取用某 profile 一个模型 id 的 LanguageModelV4。模型按
 * (profile, modelId, apiKey) 缓存——官方 openai 工厂把 apiKey 闭包进请求
 * headers，所以 key 变化时重建以覆盖为正确值；compatible / responses 风格
 * 仅把 key 注入请求 headers，缓存可复用但为简单起见统一按 key 分组。
 */
export interface LlmSdkModelCache {
  byApiKey: Map<string | undefined, Map<string, LanguageModelV4>>;
}

export function createSdkModelCache(): LlmSdkModelCache {
  return { byApiKey: new Map() };
}

/**
 * 取该 profile 一个模型 id 的 SDK 语言模型。
 * @param cache - 本 profile 的缓存。
 * @param profile - 解析后的 profile（携带 api 风格）。
 * @param modelId - 精确模型 id。
 * @param apiKey - 本次请求解析到的 key（undefined = 无认证端点）。
 * @returns 对应风格的 LanguageModelV4。
 */
export function sdkModelOf(
  cache: LlmSdkModelCache,
  profile: ResolvedProviderProfile,
  modelId: string,
  apiKey: string | undefined,
): LanguageModelV4 {
  let byModel = cache.byApiKey.get(apiKey);
  if (byModel === void 0) {
    byModel = new Map();
    cache.byApiKey.set(apiKey, byModel);
  }
  let model = byModel.get(modelId);
  if (model === void 0) {
    model = createSdkModel(profile, modelId, apiKey);
    byModel.set(modelId, model);
  }
  return model;
}

function createSdkModel(
  profile: ResolvedProviderProfile,
  modelId: string,
  apiKey: string | undefined,
): LanguageModelV4 {
  const headers = { ...profile.headers, ...attributionHeaders() };
  switch (profile.api) {
    case "openai": {
      const provider = createOpenAI({
        name: "openai",
        baseURL: profile.baseURL,
        headers,
        ...(apiKey === void 0 ? {} : { apiKey }),
      });
      return provider.chat(modelId);
    }
    case "open-responses": {
      const provider = createOpenResponses({
        name: "open-responses",
        // 该风格把 baseURL 视作 Responses POST 完整 endpoint（如
        // https://api.openai.com/v1/responses）——独立包 url 语义不带 path。
        url: profile.baseURL,
        headers,
        ...(apiKey === void 0 ? {} : { apiKey }),
      });
      return provider(modelId);
    }
    case "openai-compatible": {
      const provider = createOpenAICompatible({
        name: PROVIDER_OPTIONS_KEY,
        baseURL: profile.baseURL,
        headers,
        includeUsage: true,
        convertUsage,
      });
      return provider.chatModel(modelId);
    }
  }
}
