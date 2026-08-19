/**
 * Browser controller for one session's Timeline projection and branch mutations.
 * 精简版：HTTP 拉取 timeline + 执行操作 + 会话导航（openWhenListed）。
 */

import type {
  ClientContext,
  ConversationSnapshot,
  ISessions,
  ObservableSnapshot,
  SessionFace,
  SessionId,
  SnapshotStore,
} from "@deepseek-ai/dsh-client-runtime/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-runtime/client";
import {
  SESSION_EDITOR_PATH,
  type EditableMessageBlock,
  type SessionEditorOperation,
  type SessionEditorOperationResult,
  type SessionEditorTimeline,
  type VersionOperation,
} from "../shared.ts";

export interface SessionEditorState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  pending: VersionOperation | "cleanse" | null;
  timeline: SessionEditorTimeline | null;
  /** 会话历史加载失败（openState === "error"）——据此显示「清洗会话」入口。 */
  sessionOpenError: boolean;
}

/** 业务 face；渲染层绑定到保留的 source compartment。 */
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
  /** 清洗当前会话的 provenance 坐标为稠密空间（修复历史加载失败）。 */
  cleanse(): Promise<boolean>;
  openVersion(sessionId: string): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conversationRevision(snapshot: ConversationSnapshot): string {
  const turnEnds = [...snapshot.turnEnds.entries()]
    .map(([turn, seq]) => `${String(turn)}:${String(seq)}`)
    .join(",");
  return [snapshot.openState, snapshot.removed, snapshot.hasMore, turnEnds].join("|");
}

/** 一个会话共享一个稳定 controller（header + timeline 两个入口复用）。 */
export class SessionEditorController {
  readonly store: SnapshotStore<SessionEditorState> = createSnapshotStore<SessionEditorState>({
    status: "idle",
    error: null,
    pending: null,
    timeline: null,
    sessionOpenError: false,
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
      cleanse: () => this.mutate({ action: "cleanse", sessionId: this.sessionId }),
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
    // 历史加载失败标记：会话 snapshot 的 openState === "error" 时显示清洗入口。
    this.store.update((state) => {
      state.sessionOpenError = source?.getSnapshot().openState === "error";
    });
    this.sessionSourceDispose = source?.subscribe(() => {
      this.store.update((state) => {
        state.sessionOpenError = source.getSnapshot().openState === "error";
      });
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
        `${SESSION_EDITOR_PATH}?sessionId=${encodeURIComponent(this.sessionId)}`,
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

  private async mutate(operation: SessionEditorOperation): Promise<boolean> {
    // 只拦截并发操作；不要求 status === "ready"——编辑/重试的数据（eventSeq/
    // blockIndex/turn）来自客户端 conversation 节点，与 timeline 加载无关，
    // status 停留在 idle（无 HeaderActions 触发 load）时也必须能发起请求。
    const current = this.store.getSnapshot();
    if (current.pending !== null) return false;
    this.store.update((state) => {
      state.pending = operation.action;
      state.error = null;
    });
    try {
      const response = await fetch(SESSION_EDITOR_PATH, {
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
      const result = value as SessionEditorOperationResult;
      // edit / retry / reroll 就地编辑（不改变 session id），仅 fork 产生新 id
      // 时才需要等列表发布并打开新版本。
      if (String(result.sessionId) !== String(this.sessionId)) {
        await this.openWhenListed(result.sessionId as SessionId);
        return true;
      }
      // 就地编辑：rewind 会**删除**事件，客户端 conversation 事件流（append-only
      // 发布）无法表达删除——seq 回退只做增量，被剪掉的旧节点会残留。
      // 优先"会话级刷新"（resync：重置窗口并重新拉取历史，不整页重载）；
      // resync 不可用时回退整页重载。
      const face = this.sessions.binding(this.sessionId)?.session;
      const resync = (face as unknown as { resync?: () => Promise<void> }).resync;
      if (resync !== undefined) {
        try {
          await resync.call(face);
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

  /** 会话列表发布是导航的反应式依赖：等新版本出现在列表后再打开。 */
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
