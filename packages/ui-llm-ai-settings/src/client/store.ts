// llm-ai-sdk Models 设置页的纯数据 helpers：namespace 值投影与路径操作。
// 数据源（settingsScope）与凭据写（credentials remote）由页面注入面提供；
// 本文件不含 React / wire 依赖，便于直接单测。

import type { SettingsPathOpView } from "@deepseek-ai/dsh-api-remotes/client";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

/** 从 namespace 的 resolved value 读 providers dict 键（配置顺序）。 */
export function providerIdsOf(value: JsonValue | undefined): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const providers = (value as { providers?: unknown }).providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return [];
  return Object.keys(providers as Record<string, unknown>);
}

/**
 * 一 provider profile 的路径操作：把编辑后的字段集写成 minimal path ops。
 * 只命名发生变化的字段；字段从有到无发 unset。与上游 Models 页 pathOps
 * 同语义（字段集由调用方给出，本实现不假设 schema 形状）。
 */
export function profilePathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOpView[] {
  const previous =
    typeof before === "object" && before !== null && !Array.isArray(before)
      ? (before as Record<string, unknown>)
      : {};
  const ops: SettingsPathOpView[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue;
    ops.push({ op: "set", path: [...base, key], value: value as JsonValue });
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: "unset", path: [...base, key] });
  }
  return ops;
}

/** `<ROUTE>_API_KEY`：与上游 Models 页一致的约定式凭据引用。 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** 删除一个 provider 的路径操作（整个 providers.<route> 子树 unset）。 */
export function deleteProviderOp(provider: string): SettingsPathOpView {
  return { op: "unset", path: ["providers", provider] };
}

/** 一 profile 的可编辑字段（UI draft）。 */
export interface ProfileDraft {
  apiKeyEnv: string;
  api: string;
  baseURL: string;
  displayName: string;
  models: string;
}

/** 字符串字段读取；非 string 视为未设置。 */
export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 从已解析 profile 投影出可编辑字段（空串 = 未设置；models 展示为 JSON）。 */
export function draftFrom(profile: Record<string, unknown> | undefined): ProfileDraft {
  const models = profile?.models;
  return {
    apiKeyEnv: stringOf(profile?.apiKeyEnv) ?? "",
    api: stringOf(profile?.api) ?? "openai-compatible",
    baseURL: stringOf(profile?.baseURL) ?? "",
    displayName: stringOf(profile?.displayName) ?? "",
    models: typeof models === "string" ? models : JSON.stringify(models ?? [], null, 2),
  };
}

/**
 * 收集编辑字段相对 before 的路径操作。空字段名被清掉（不 set）；models
 * 文本必须解析为 JSON 数组，否则返回 error。
 */
/** 编辑卡片管理的确切字段集：diff 只在这些 key 上进行，其余 profile 字段
 * （采样默认、reasoning、传输参数等）由编辑卡片外的层拥有，绝不触碰。 */
const EDITABLE_FIELDS = ["apiKeyEnv", "api", "baseURL", "displayName", "models"] as const;

/**
 * 收集编辑字段相对 before 的变化为路径操作。只对 {@link EDITABLE_FIELDS}
 * 判 diff：一个字段 draft 为空即清掉（unset）；before 里不属于编辑字段的
 * key 永远不会出现在结果里（避免误删卡片外的配置）。
 * models 文本必须解析为 JSON 数组，否则返回 error。
 */
export function opsFor(
  provider: string,
  before: Record<string, unknown> | undefined,
  draft: ProfileDraft,
): { ops: SettingsPathOpView[]; error?: string } {
  const after: Record<string, unknown> = {};
  const keep = (key: string, value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length > 0) after[key] = trimmed;
  };
  keep("apiKeyEnv", draft.apiKeyEnv);
  after.api = draft.api;
  keep("baseURL", draft.baseURL);
  keep("displayName", draft.displayName);
  const trimmedModels = draft.models.trim();
  if (trimmedModels.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedModels);
    } catch {
      return { ops: [], error: "invalid models JSON" };
    }
    if (!Array.isArray(parsed)) return { ops: [], error: "models must be an array" };
    after.models = parsed;
  }

  const previous =
    typeof before === "object" && before !== null && !Array.isArray(before)
      ? (before as Record<string, unknown>)
      : {};
  const ops: SettingsPathOpView[] = [];
  const path = ["providers", provider] as const;
  for (const key of EDITABLE_FIELDS) {
    const changed = JSON.stringify(previous[key]) !== JSON.stringify(after[key]);
    if (!changed) continue;
    if (key in after) {
      ops.push({ op: "set", path: [...path, key], value: after[key] as JsonValue });
    } else {
      ops.push({ op: "unset", path: [...path, key] });
    }
  }
  return { ops };
}
