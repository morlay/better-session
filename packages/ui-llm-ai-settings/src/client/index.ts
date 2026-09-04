// llm-ai-sdk 设置页（browser 面）：注册一个 settings.section 新页面，编辑
// `llm-ai-sdk` settings namespace 的 providers（仿上游 Models 页体验）。
//
// 数据与写通道：
// - 读：`ctx.settingsScope.bind({ namespace: 'llm-ai-sdk' })`（共享 describe
//   mirror，无独立 wire 读）。
// - 写：scope.mutate(ops, revision)（含 revision fence + recovery）。
// - API key：`ctx.remote.credentials.set/unset`（值永不进 settings 文档，
//   profile 只记 apiKeyEnv 引用）。
// 导出纪律遵循 client 包规范：只有 apply/inject 与页面类型可导出。

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { en, zh } from "./locales.ts";
import type { LlmAiModelsKey } from "./locales.ts";
import { AiSdkModelsSection } from "./AiSdkModelsSection.tsx";
import type { AiSdkModelsSectionInjected } from "./AiSdkModelsSection.tsx";

/** 词典命名空间（settings.section label 与页面文案）。 */
const NS = "llm-ai-sdk-models";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** llm-ai-sdk Models 设置页文案。 */
    "llm-ai-sdk-models": LlmAiModelsKey;
  }
}

export type { LlmAiModelsKey } from "./locales.ts";

/** client 包插件契约。 */
export const inject = [
  "slots",
  "locale",
  "remote",
  "remote.credentials",
  "remote.settings",
  "settingsScope",
];

/**
 * 注册 llm-ai-sdk 的 Models 设置页。slot 声明（settings.section）由
 * ui-settings-general 的 shell 提供，这里经 slots.inject 等它出现。
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    "llm-ai-sdk-models: copy dictionaries",
  );
  const scope = ctx.settingsScope.bind<{ providers?: Record<string, unknown> }>({
    namespace: "llm-ai-sdk",
  });
  const t = ctx.locale.bind(NS) as AiSdkModelsSectionInjected["t"];

  const injected = (): AiSdkModelsSectionInjected => ({
    scope,
    hooks: { models: scope },
    operations: {
      describeCredential: async (ref: string) => {
        const response = await ctx.remote.credentials.describe([ref]);
        return response.ok ? response.value[ref] : undefined;
      },
      storeCredential: async (ref: string, value: string) => {
        const response = await ctx.remote.credentials.set(ref, value);
        return response.ok ? undefined : response.error.message;
      },
      removeCredential: async (ref: string) => {
        const response = await ctx.remote.credentials.unset(ref);
        return response.ok ? undefined : response.error.message;
      },
    },
    t,
  });

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "llm-ai-sdk",
        order: 20,
        label: () => t("nav"),
        locale: NS,
        inject: injected,
      } as never,
      AiSdkModelsSection as never,
    ),
  );
}
