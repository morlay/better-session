import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {
  ISessions,
  SessionFace,
  SessionSnapshot,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { ObservableSnapshot, SnapshotStore } from "@deepseek-ai/dsh-client-store";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  SESSION_EDITOR_PATH,
  type EditableMessageBlock,
  type SessionEditorOperation,
  type SessionEditorOperationResult,
  type SessionEditorTimeline,
  type VersionOperation,
} from "../shared.ts";

/** desktop 壳（官方 dsh-desktop-host）注入的 transport 标记：ownsHost 时 API 走 /api 前缀。 */
function editorApiPath(): string {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { ownsHost?: boolean } })
    .__DSH_TRANSPORT__;
  return transport?.ownsHost === true ? `/api${SESSION_EDITOR_PATH}` : SESSION_EDITOR_PATH;
}

export interface SessionEditorState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  pending: VersionOperation | "recall" | "import" | null;
  timeline: SessionEditorTimeline | null;
}

export interface SessionEditorFace {
  hooks: { sessionEditor: ObservableSnapshot<SessionEditorState> };
  acquire(): () => void;
  load(): void;
  edit(
    message: EditableMessageBlock,
    text: string,
    cascade: "truncate" | "preserve",
  ): Promise<boolean>;
  retry(turn: number, cascade: "truncate" | "preserve"): Promise<boolean>;
  reroll(): Promise<boolean>;
  rewind(toBoundary: number): Promise<boolean>;
  recall(message: EditableMessageBlock): Promise<boolean>;

  importSession(file: File): Promise<boolean>;
  openVersion(sessionId: string): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conversationRevision(snapshot: SessionSnapshot): string {
  // 新版 SessionSnapshot 已无 turnEnds（会话级事件窗口不再暴露轮次边界）；
  // 用生命周期字段作为会话变化指纹即可。
  return [snapshot.openState, snapshot.removed, snapshot.hasMore].join("|");
}

export class SessionEditorController {
  readonly store: SnapshotStore<SessionEditorState> = createSnapshotStore<SessionEditorState>({
    status: "idle",
    error: null,
    pending: null,
    timeline: null,
  });

  readonly face: SessionEditorFace;
  private readonly ctx: ClientContext;
  private readonly sessions: ISessions;
  private sessionSource: SessionFace | undefined;
  private sessionSourceDispose: (() => void) | undefined;
  private sessionRevision: string | undefined;
  private disposed = false;
  private users = 0;
  private readonly navigationWaits = new Set<() => void>();

  constructor(
    ctx: ClientContext,
    private readonly sessionId: SessionId,
  ) {
    this.ctx = ctx;
    this.sessions = ctx.get("sessions") as unknown as ISessions;
    this.face = {
      hooks: { sessionEditor: this.store },
      acquire: () => {
        this.users += 1;
        if (this.users === 1 && this.disposed) this.revive();
        return () => this.release();
      },
      load: () => {
        void this.load();
      },
      edit: (message, text, cascade) =>
        this.mutate({
          action: "edit",
          sessionId: this.sessionId,
          eventSeq: message.eventSeq,
          blockIndex: message.blockIndex,
          text,
          cascade,
        }),
      retry: (turn, cascade) =>
        this.mutate({ action: "retry", sessionId: this.sessionId, turn, cascade }),
      reroll: () => this.mutate({ action: "reroll", sessionId: this.sessionId }),
      rewind: (toBoundary) =>
        this.mutate({ action: "rewind", sessionId: this.sessionId, toBoundary }),
      recall: (message) =>
        this.mutate(
          { action: "recall", sessionId: this.sessionId, eventSeq: message.eventSeq },
          () => this.setComposerDraft(message.text),
        ),
      importSession: (file) => this.importSession(file),
      openVersion: (sessionId) => this.openWhenListed(sessionId as SessionId),
    };
    this.observe();
  }

  private observe(): void {
    this.sessionSource = undefined;
    this.sessionSourceDispose?.();
    this.bindSessionSource();
    this.sessions.list.subscribe(() => this.invalidate());
  }

  private bindSessionSource(): void {
    const source = this.sessions.binding(this.sessionId)?.session;
    if (source === this.sessionSource) return;
    this.sessionSourceDispose?.();
    this.sessionSource = source;
    this.sessionRevision =
      source === undefined ? undefined : conversationRevision(source.getSnapshot());
    this.sessionSourceDispose = source?.subscribe(() => {
      this.invalidate();
    });
  }

  private invalidate(): void {
    if (this.disposed || this.store.getSnapshot().status === "idle") return;
    // 会话状态变化 → 刷新投影（debounce 由调用方按需）。
    void this.load();
  }

  private release(): void {
    this.users -= 1;
    if (this.users <= 0) this.dispose();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessionSourceDispose?.();
    this.sessionSourceDispose = undefined;
    this.sessionSource = undefined;
    this.sessionRevision = undefined;
  }

  private revive(): void {
    this.disposed = false;
    this.observe();
    void this.load();
  }

  async load(): Promise<void> {
    if (this.disposed) return;
    this.store.update((state) => {
      state.status = "loading";
      state.error = null;
    });
    try {
      const response = await fetch(
        `${editorApiPath()}?sessionId=${encodeURIComponent(this.sessionId)}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
        },
      );
      const value = (await response.json()) as unknown;
      if (this.disposed) return;
      if (response.ok) {
        this.store.update((state) => {
          state.status = "ready";
          state.error = null;
          state.timeline = value as SessionEditorTimeline;
        });
      } else {
        const error = (value as { error?: unknown })["error"];
        this.store.update((state) => {
          state.status = "error";
          state.error =
            typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`;
        });
      }
    } catch (error) {
      if (this.disposed) return;
      this.store.update((state) => {
        state.status = "error";
        state.error = messageOf(error);
      });
    }
  }

  private async mutate(
    operation: SessionEditorOperation,
    onApplied?: () => void,
  ): Promise<boolean> {
    // 只拦截并发操作；不要求 status === "ready"——编辑/重试的数据来自客户端
    // conversation 节点，与 timeline 加载无关，status 为 idle 时也可发起请求。
    const current = this.store.getSnapshot();
    if (current.pending !== null) return false;
    this.store.update((state) => {
      state.pending = operation.action;
      state.error = null;
    });
    try {
      const response = await fetch(editorApiPath(), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(operation),
      });
      const value = (await response.json()) as unknown;
      if (this.disposed) return true;
      if (!response.ok) {
        const error = (value as { error?: unknown })["error"];
        throw new Error(
          typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`,
        );
      }
      this.store.update((state) => {
        state.pending = null;
      });
      // recall 的草稿回填必须在刷新（resync / 整页重载）之前：草稿经会话级
      // 持久化 mirror 落 store，整页重载后仍能恢复。
      onApplied?.();
      const result = value as SessionEditorOperationResult;
      // 仅 fork 产生新 id 时需要等列表发布并打开新版本；就地编辑不改 id。
      if (String(result.sessionId) !== String(this.sessionId)) {
        await this.openWhenListed(result.sessionId as SessionId);
        return true;
      }
      // 就地编辑：rewind 删除事件，append-only 事件流无法表达删除——seq
      // 回退只做增量，被剪掉的旧节点残留。优先会话级刷新（resync 重置窗口
      // 并重新拉取历史）；不可用时回退整页重载。
      const face = this.sessions.binding(this.sessionId)?.session;
      const resync = (face as unknown as { resync?: () => Promise<void> }).resync;
      if (resync !== undefined) {
        try {
          await resync.call(face);
          // resync 只重建事件窗口；投影 store 按 higher-seq-wins 保留 rewind
          // 前的高 seq 旧值（截断后的正确值 seq 更小，永远覆盖不上），轮次
          // 导航会残留已删除的轮次。丢弃全部投影行，等 host 推送重建；拿不到
          // 丢弃入口时整页重载兜底。
          const projections = (
            face as unknown as { projections?: { truncate?(lastSeq: number): void } }
          ).projections;
          if (typeof projections?.truncate !== "function") {
            location.reload();
            return true;
          }
          projections.truncate(-1);
          void this.load();
          return true;
        } catch {
          // fall through to full reload
        }
      }
      location.reload();
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.store.update((state) => {
        state.pending = null;
        state.error = messageOf(error);
      });
      return false;
    }
  }

  /**
   * 把撤回的消息文本回填到该会话的 composer 草稿（`conversation.input` 的
   * `setDraft`，即主输入框的整段替换语义）。会话 scope / binding / conversation
   * 服务缺失时静默跳过——撤回本身已成功，草稿回填失败不应回滚会话状态。
   */
  private setComposerDraft(text: string): void {
    // binding 缺失时 input.for 会抛（会话 scope 已拆除），先短路。
    if (this.sessions.binding(this.sessionId) === undefined) return;
    const scoped = this.sessions.scope(this.sessionId);
    if (scoped === undefined) return;
    const conversation = scoped.get("conversation") as
      | { input?: { for(ctx: ClientContext): { setDraft(text: string): void } } }
      | undefined;
    conversation?.input?.for(scoped).setDraft(text);
  }

  private async importSession(file: File): Promise<boolean> {
    const current = this.store.getSnapshot();
    if (current.pending !== null) return false;
    this.store.update((state) => {
      state.pending = "import";
      state.error = null;
    });
    try {
      const zip = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          const comma = dataUrl.indexOf(",");
          resolve(comma < 0 ? dataUrl : dataUrl.slice(comma + 1));
        };
        reader.onerror = () =>
          reject(reader.error ?? new Error("failed to read the selected file"));
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/session.import", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ zip, sessionId: this.sessionId }),
      });
      const value = (await response.json()) as unknown;
      if (this.disposed) return true;
      if (!response.ok) {
        const error = (value as { error?: unknown })["error"];
        throw new Error(
          typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`,
        );
      }
      this.store.update((state) => {
        state.pending = null;
      });
      // 覆盖成功但**不能**走 resync：resync 重开事件流时 observeSession 仍
      // 优先读 live session（rewind 已截断其内存 log，append 只写 DB），会
      // 再读到空/截断数据。整页重载让会话从 live 卸载，冷读 DB 完整数据。
      location.reload();
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.store.update((state) => {
        state.pending = null;
        state.error = messageOf(error);
      });
      return false;
    }
  }

  private openWhenListed(sessionId: SessionId): Promise<void> {
    if (this.sessions.list.getSnapshot().byId[sessionId] !== undefined) {
      this.sessions.open(sessionId);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let dispose = (): void => {};
      const finish = (open: boolean): void => {
        if (settled) return;
        settled = true;
        dispose();
        this.navigationWaits.delete(cancel);
        if (open) this.sessions.open(sessionId);
        resolve();
      };
      const cancel = (): void => {
        finish(false);
      };
      this.navigationWaits.add(cancel);
      dispose = this.sessions.list.subscribe(() => {
        if (this.sessions.list.getSnapshot().byId[sessionId] === undefined) return;
        finish(true);
      });
      if (this.sessions.list.getSnapshot().byId[sessionId] !== undefined) finish(true);
    });
  }
}
