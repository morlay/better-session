import { describe, expect, it } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import type { ResolvedProviderProfile } from "@morlay/dsh-llm-ai-sdk";
import {
  DEFAULT_LLM_API,
  LLM_APIS,
  apiDisplayName,
  createSdkModelCache,
  sdkModelOf,
} from "@morlay/dsh-llm-ai-sdk";

function profile(overrides?: Partial<ResolvedProviderProfile>): ResolvedProviderProfile {
  return {
    provider: "test",
    displayName: "Test",
    api: "openai-compatible",
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

describe("LLM_APIS", () => {
  it("lists every supported transport style with the compatible default", () => {
    expect([...LLM_APIS]).toEqual(["openai-compatible", "openai", "open-responses"]);
    expect(DEFAULT_LLM_API).toBe("openai-compatible");
  });

  it("gives every style a display name", () => {
    for (const api of LLM_APIS) expect(apiDisplayName(api).length).toBeGreaterThan(0);
  });
});

describe("sdkModelOf", () => {
  it("constructs a LanguageModelV4 for each style without network I/O", () => {
    for (const api of LLM_APIS) {
      const cache = createSdkModelCache();
      const model = sdkModelOf(cache, profile({ api }), "m1", "secret");
      expect(model).toBeDefined();
      expect(typeof model.doStream).toBe("function");
      const cached = sdkModelOf(cache, profile({ api }), "m1", "secret");
      // 同一 profile 引用与 key 命中缓存（同一实例）。
      const same = sdkModelOf(cache, profile({ api }), "m1", "secret");
      expect(same).toBe(model);
      expect(cached).toBeDefined();
      expect(model.specificationVersion).toBe("v4");
    }
  });

  it("rebuilds per apiKey so a later credential lands in the factory headers", () => {
    const cache = createSdkModelCache();
    const p = profile({ api: "openai" });
    const first = sdkModelOf(cache, p, "m1", "key-a");
    const second = sdkModelOf(cache, p, "m1", "key-b");
    expect(second).not.toBe(first);
    const again = sdkModelOf(cache, p, "m1", "key-a");
    expect(again).toBe(first);
  });

  it("caches models per profile across model ids", () => {
    const cache = createSdkModelCache();
    const p = profile();
    const a = sdkModelOf(cache, p, "m1", void 0);
    const b = sdkModelOf(cache, p, "m2", void 0);
    expect(a).not.toBe(b);
    expect(a.specificationVersion).toBe("v4");
    expect((b as LanguageModelV4).specificationVersion).toBe("v4");
  });
});
