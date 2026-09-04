// llm-ai-sdk Models 设置页主体：providers 行列表 + 单卡片编辑。
//
// 数据来自 scope snapshot（settingsScope.bind 的 namespace 镜像）：
// - value = 已解析 namespace（entry config 默认 + user 覆盖）
// - revision = 写 fence（scope.mutate 自动带，含 conflict recovery）
// 提交：编辑字段 diff → scope.mutate(pathOps)；API key 单独走 credentials
// （值不进 settings 文档，profile 记 apiKeyEnv 引用）。

import { useEffect, useState, type ReactNode } from "react";
import type { CredentialInfo } from "@deepseek-ai/dsh-api-remotes/client";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { LlmAiModelsKey } from "./locales.ts";
import {
  deleteProviderOp,
  deriveKeyRef,
  draftFrom,
  opsFor,
  stringOf,
} from "./store.ts";
import type { ProfileDraft } from "./store.ts";
import css from "./AiSdkModelsSection.module.css";

/** 凭据写面（apply 组装）。 */
export interface AiSdkModelsOperations {
  describeCredential(ref: string): Promise<CredentialInfo | undefined>;
  storeCredential(ref: string, value: string): Promise<string | undefined>;
  removeCredential(ref: string): Promise<string | undefined>;
}

/** apply 注入给页面组件的业务面。 */
export interface AiSdkModelsSectionInjected {
  scope: SettingsScope<{ providers?: Record<string, unknown> }>;
  hooks: {
    models: SettingsScope<{ providers?: Record<string, unknown> }>;
  };
  operations: AiSdkModelsOperations;
  t: (key: LlmAiModelsKey) => string;
}

type ModelsSection = { providers?: Record<string, unknown> };

const API_CHOICES = ["openai-compatible", "openai", "open-responses"] as const;

/** 已解析 namespace 中某 provider 的 profile（plain object）。 */
function profileValue(
  value: ModelsSection | undefined,
  provider: string,
): Record<string, unknown> | undefined {
  const profile = value?.providers?.[provider];
  return typeof profile === "object" && profile !== null && !Array.isArray(profile)
    ? (profile as Record<string, unknown>)
    : undefined;
}

/** providers dict 的直接子键；非对象值返回空。 */
function providerIdsOf(section: ModelsSection | undefined): string[] {
  const providers = section?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return [];
  return Object.keys(providers);
}

/** 页面主组件。 */
export function AiSdkModelsSection(
  props: PropsRuntime<"settings.section"> & InjectFace<AiSdkModelsSectionInjected>,
): ReactNode {
  const t = props.t;
  const scope = props.scope;
  const useModels = props.useModels as (selector: (s: SettingsScopeSnapshot<ModelsSection>) => SettingsScopeSnapshot<ModelsSection>) => SettingsScopeSnapshot<ModelsSection>;
  const snapshot = useModels((s) => s);
  const providers = providerIdsOf(snapshot.value);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const readOnly = snapshot.status !== "ready" || !snapshot.writable;

  if (snapshot.status === "loading") {
    return <p>{t("nav")}…</p>;
  }
  if (snapshot.status === "unavailable") {
    return <p>{t("readOnly")}</p>;
  }

  const openEditor = (provider: string): void => {
    setEditing((current) => (current === provider ? undefined : provider));
  };

  const handleRemove = async (provider: string, refName: string): Promise<void> => {
    if (!window.confirm(`Delete provider "${provider}"?`)) return;
    setRemoving(provider);
    setRemoveError(undefined);
    try {
      // 移除整个 profile；其约定式凭据引用也一并清除（值不进 settings）。
      await scope.mutate([deleteProviderOp(provider)], snapshot.revision);
      await props.operations.removeCredential(refName);
      if (editing === provider) setEditing(undefined);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoving(undefined);
    }
  };

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t("title")}</h2>
      <p className={css.intro}>{t("intro")}</p>
      {!snapshot.writable ? <p className={css.notice}>{t("readOnly")}</p> : null}
      {removeError !== undefined ? <p className={css.error}>{removeError}</p> : null}
      {providers.length === 0 && editing === undefined && !adding ? (
        <p className={css.empty}>{t("noProviders")}</p>
      ) : null}
      {providers.map((provider) => {
        const profile = profileValue(snapshot.value, provider);
        const ref = stringOf(profile?.apiKeyEnv) ?? deriveKeyRef(provider);
        const open = editing === provider;
        const displayName = stringOf(profile?.displayName);
        return (
          <div key={provider} className={css.row}>
            <div className={css.rowHead}>
              <span className={css.rowName}>{provider}</span>
              {displayName !== undefined
                ? <span className={css.rowSub}>{displayName}</span>
                : null}
              <button
                type="button"
                disabled={readOnly}
                onClick={() => openEditor(provider)}
              >
                {open ? t("close") : t("edit")}
              </button>
              <button
                type="button"
                disabled={readOnly || removing === provider}
                onClick={() => { void handleRemove(provider, ref); }}
              >
                {removing === provider ? "…" : t("remove")}
              </button>
            </div>
            {open ? (
              <EditorCard
                provider={provider}
                refName={ref}
                before={profile}
                scope={scope}
                snapshot={snapshot}
                operations={props.operations}
                t={t}
              />
            ) : null}
          </div>
        );
      })}
      {adding ? (
        <AddCard
          providers={providers}
          scope={scope}
          snapshot={snapshot}
          t={t}
          onCancel={() => setAdding(false)}
          onAdded={() => setAdding(false)}
        />
      ) : (
        <button type="button" disabled={readOnly} onClick={() => setAdding(true)}>
          {t("add")}
        </button>
      )}
    </div>
  );
}

interface EditorCardProps {
  provider: string;
  refName: string;
  before: Record<string, unknown> | undefined;
  scope: SettingsScope<ModelsSection>;
  snapshot: SettingsScopeSnapshot<ModelsSection>;
  operations: AiSdkModelsOperations;
  t: (key: LlmAiModelsKey) => string;
}

function EditorCard({
  provider,
  refName,
  before,
  scope,
  snapshot,
  operations,
  t,
}: EditorCardProps): ReactNode {
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFrom(before));
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [credential, setCredential] = useState<CredentialInfo | undefined>(undefined);

  useEffect(() => {
    let stale = false;
    void operations.describeCredential(refName).then((described) => {
      if (!stale) setCredential(described);
    });
    return () => { stale = true; };
  }, [operations, refName]);

  const setField = (key: keyof ProfileDraft, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const apply = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try {
      const { ops, error } = opsFor(provider, before, draft);
      if (error !== undefined) {
        setFailure(error);
        return;
      }
      if (ops.length > 0) await scope.mutate(ops, snapshot.revision);
      if (keyDraft.trim().length > 0) {
        const stored = await operations.storeCredential(refName, keyDraft.trim());
        if (stored !== undefined) {
          setFailure(stored);
          return;
        }
      }
      setKeyDraft("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={css.card}>
      <label className={css.field}>
        <span>{t("api")}</span>
        <select
          value={draft.api}
          disabled={busy}
          onChange={(event) => setField("api", event.target.value)}
        >
          {API_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </label>
      <label className={css.field}>
        <span>{t("apiKeyEnv")}</span>
        <input
          value={draft.apiKeyEnv}
          placeholder={t("apiKeyEnvPlaceholder")}
          disabled={busy}
          onChange={(event) => setField("apiKeyEnv", event.target.value)}
        />
      </label>
      <label className={css.field}>
        <span>{t("baseUrl")}</span>
        <input
          value={draft.baseURL}
          placeholder="https://…"
          disabled={busy}
          onChange={(event) => setField("baseURL", event.target.value)}
        />
      </label>
      <label className={css.field}>
        <span>{t("displayName")}</span>
        <input
          value={draft.displayName}
          placeholder={t("displayNamePlaceholder")}
          disabled={busy}
          onChange={(event) => setField("displayName", event.target.value)}
        />
      </label>
      <label className={css.field}>
        <span>{t("models")}</span>
        <textarea
          value={draft.models}
          rows={5}
          disabled={busy}
          onChange={(event) => setField("models", event.target.value)}
        />
      </label>
      <label className={css.field}>
        <span>{t("apiKeyInput")}</span>
        <input
          type="password"
          value={keyDraft}
          placeholder={credential?.configured === true ? t("apiKeyStored") : undefined}
          disabled={busy}
          onChange={(event) => setKeyDraft(event.target.value)}
        />
      </label>
      {failure !== undefined ? <p className={css.error}>{failure}</p> : null}
      <div className={css.actions}>
        <button type="button" disabled={busy} onClick={() => { void apply() }}>
          {busy ? t("applying") : t("apply")}
        </button>
      </div>
    </div>
  );
}

interface AddCardProps {
  providers: readonly string[];
  scope: SettingsScope<ModelsSection>;
  snapshot: SettingsScopeSnapshot<ModelsSection>;
  t: (key: LlmAiModelsKey) => string;
  onCancel: () => void;
  onAdded: () => void;
}

function AddCard({
  providers,
  scope,
  snapshot,
  t,
  onCancel,
  onAdded,
}: AddCardProps): ReactNode {
  const [provider, setProvider] = useState("");
  const [api, setApi] = useState<string>("openai-compatible");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const normalized = provider.trim();

  const add = async (): Promise<void> => {
    if (normalized.length === 0) {
      setFailure(t("invalidRoute"));
      return;
    }
    if (providers.includes(normalized)) {
      setFailure(t("duplicatedRoute"));
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await scope.mutate(
        [{ op: "set", path: ["providers", normalized], value: { api } }],
        snapshot.revision,
      );
      onAdded();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={css.card}>
      <label className={css.field}>
        <span>{t("providerId")}</span>
        <input
          value={provider}
          disabled={busy}
          onChange={(event) => setProvider(event.target.value)}
        />
      </label>
      <label className={css.field}>
        <span>{t("api")}</span>
        <select value={api} disabled={busy} onChange={(event) => setApi(event.target.value)}>
          {API_CHOICES.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </label>
      {failure !== undefined ? <p className={css.error}>{failure}</p> : null}
      <div className={css.actions}>
        <button type="button" disabled={busy || normalized.length === 0} onClick={() => { void add() }}>
          {busy ? t("adding") : t("add")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
