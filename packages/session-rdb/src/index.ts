/**
 * SQLite / PostgreSQL durable session-persistence backend.
 *
 * Storage follows the playpen-session store: `t_sessions` carries the header
 * and a head cursor, `t_events` stores each event as a globally addressable
 * entity (event id + parent chain + kind/role/name/action-id dimensions), and
 * `t_session_events` bridges sessions to events in per-session seq order.
 * Delta content (`assistant/chunk`) is never persisted: those events are
 * dropped and the surviving events are re-numbered to a dense persisted seq
 * (`f_original_seq` keeps the upstream seq for provenance remapping).
 *
 * The database is chosen by configuration (discriminated union on `type`):
 * `{ type: "sqlite", path }` or `{ type: "postgres", connectionString }`.
 * All access goes through drizzle; the schema is declared once per dialect
 * (`schema.ts` / `postgres.ts`) and the hand-written DDL there is the only
 * migration story (no migration toolchain — incompatible stores are rejected,
 * never migrated).
 *
 * It delegates write-path orchestration to {@link PersistenceCoordinator} and
 * has no independent per-session artifact, so its locator returns `undefined`.
 * @module @morlay/session-rdb
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import {
  SessionPersistence,
  SessionPersistenceRevision,
  PersistenceCoordinator,
  type PersistenceBackend,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type SessionStorageMetadata,
  type StoredPrefix,
  type StoredSuffix,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SurfaceEventType,
  type SessionId,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { type Backend, type BackendTx, type EventInsert, type EventRow } from "./backend.ts";
import { WriteGuard } from "./write-guard.ts";
import { buildSeqMap, recomputeReplaceProvenance, rowToMeta, scanRows, toJsonlArtifact } from "./log.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  eventDimensions,
  EVENT_ENCODING,
  isPersistedEvent,
  type JournalMode,
} from "./schema.ts";
import { SqliteBackend } from "./sqlite.ts";
import { PostgresBackend } from "./postgres.ts";
import { SessionBranchRdb } from "./branch.ts";
import { registerSessionImport } from "./import.ts";

export { SCHEMA_VERSION, EPHEMERAL_EVENT_TYPES } from "./schema.ts";
export { SessionBranchRdb, SessionBranchRdbProvider, locateTurnEnd } from "./branch.ts";

/**
 * 同包分支 provider（rewind / forkFrom）访问 `SessionPersistenceRdb` 内部
 * 能力的窄接口。避免把 backend / writeGuard 暴露成公开 API，同时让
 * {@link SessionBranchRdbProvider} 与持久化后端共享同一连接与写路径。
 * @internal
 */
export interface SessionPersistenceRdbInternals {
  readonly backend: Backend;
  readonly writeGuard: WriteGuard;
  create(meta: SessionHeader, inheritedEventCount?: number): Promise<void>;
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void>;
  load(id: SessionId): Promise<import("@deepseek-ai/dsh-session-persistence").SessionInspection>;
  inspect(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionInspection>;
  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionEventSuffix>;
  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>;
  readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionPersistenceRevision | undefined>;
  /** 注册 fork 派生会话的事件行复用映射（上游 seq → 已存在事件行 id）。 */
  registerReuseEventIds(childId: SessionId, map: ReadonlyMap<number, string>): void;
}

/**
 * Plugin configuration — a discriminated union on `type`. The SQLite arm keeps
 * the file path plus the SQLite-specific pragmas; the PostgreSQL arm takes a
 * `node-postgres` connection string.
 */
export type Config =
  | {
      type: "sqlite";
      /**
       * Filesystem path to the SQLite database file. The special value `:memory:`
       * opens an in-process database (tests). On filesystems with POSIX modes,
       * missing directories and databases are created owner-only; existing path
       * modes are preserved.
       */
      path: string;
      /**
       * SQLite `journal_mode` pragma. `wal` (the default) is the recorded
       * durability model; pick a rollback-journal mode (`delete`/`truncate`/
       * `persist`) on filesystems where WAL's shared-memory files do not work
       * (network mounts). See {@link JournalMode}.
       */
      journalMode?: JournalMode;
      /**
       * Milliseconds to wait for a contended write lock before failing. SQLite
       * fails immediately by default, so a second process sharing this database
       * would lose every append that meets an in-flight commit; a nonzero wait
       * turns the contention window into a queue. `0` restores fail-fast.
       */
      busyTimeout?: number;
    }
  | {
      type: "postgres";
      /**
       * `node-postgres` connection string (e.g.
       * `postgres://user:pass@host:5432/db`). The database must be reachable;
       * the backend creates its tables and identity on first open.
       */
      connectionString: string;
      /**
       * PostgreSQL schema to hold the session tables. Defaults to `public`.
       * The schema must exist (or be creatable by the connecting role); the
       * backend does not create it.
       */
      schema?: string;
    };

/**
 * The persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker is the persisted seq to delete from.
 *
 * Configuration resolution: `$DSH_HOME/settings.yaml` 的
 * `session-rdb` namespace（settings 服务）覆盖 cordis 层 entry
 * config，见 {@link SettingsProvider.register}。
 */
export class SessionPersistenceRdb
  extends SessionPersistence
  implements PersistenceBackend<number>
{
  static inject = ["sessions", "settings"];

  static Config: z<Config> = z.union([
    z.object({
      type: z.const("sqlite"),
      path: z.string().required(),
      journalMode: z.union(["wal", "delete", "truncate", "persist"] as const).default("wal"),
      busyTimeout: z.number().step(1).min(0).default(DEFAULT_BUSY_TIMEOUT_MS),
    }),
    z.object({
      type: z.const("postgres"),
      connectionString: z.string().required(),
      schema: z.string().default("public"),
    }),
  ]);

  /** settings namespace：`$DSH_HOME/settings.yaml` 的 `session-rdb` section。 */
  static readonly settingsNs = "session-rdb";

  /**
   * Backend label for the coordinator's dispose diagnostics. Intentionally
   * shadows cordis `Service.name` (set to `'sessionPersistence'` by the base);
   * see the JSONL backend for why this does not affect service resolution.
   */
  override readonly name = "session-rdb";

  /** RDB 行可导出为 JSONL raw artifact（`readRaw` 实现），供 session-log-export 消费。 */
  override readonly supportsRawArtifacts = true;

  /**
   * 导出用 raw artifact：把 RDB 行转成 JSONL 文本（header 行 + 每事件一行，
   * 与上游 JSONL 后端物理布局一致），供 `session-log-export` 的 zip 流消费。
   * 会话不存在时返回 undefined。
   */
  override async readRaw(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionRawArtifact | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const log = await this.readLog(id, {}, signal);
    if (log === undefined) return undefined;
    return {
      meta: log.meta,
      inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
      filename: "session.jsonl",
      content: toJsonlArtifact(log.meta, log.inheritedEventCount, log.events),
    };
  }

  private readonly backend: Backend;
  private storeIdentity!: string;
  private readonly ready: Promise<void>;
  private readonly coordinator: PersistenceCoordinator<number>;
  /**
   * Write-authority state: the confirmed dense head per session (concurrent-
   * writer detection). See {@link WriteGuard} for the timing contract.
   */
  private readonly writeGuard = new WriteGuard();
  /**
   * 待复用事件行映射（fork 派生用）：childId → 上游 seq → 已存在事件行的
   * f_event_id。forkFrom 注册后，下一次 appendBatch 消费（复用事件行、不
   * 复制），消费后清除。
   */
  private readonly reuseEventIds = new Map<SessionId, Map<number, string>>();

  constructor(
    ctx: Context,
    public config: Config,
    /**
     * @internal Test injection: use a pre-built backend (e.g. a drizzle PG
     * instance over an in-memory pglite) instead of {@link createBackend}.
     */
    injectedBackend?: Backend,
  ) {
    // settings.yaml 的 `session-rdb` namespace 覆盖 cordis 层 entry
    // config（base）。settings 服务已注册时（dsh 环境；服务注册完成即初始
    // publish 完成，见 SettingsProvider[Service.init]）同步 register 读取；settings
    // 服务缺失时（纯 cordis 装配/测试）退化为 entry config。经 ctx.reflect
    // 查询避免未 inject 的 ctx 服务访问守卫。
    let resolved: Config = config;
    const settings = ctx.reflect.get("settings") as unknown as SettingsProvider | undefined;
    if (settings !== undefined) {
      const scope = settings.register(
        SessionPersistenceRdb.settingsNs,
        SessionPersistenceRdb.Config,
        { base: config },
      );
      resolved = scope.get();
      scope.watch(() => {
        // 后端在构造时建成（数据库连接 + coordinator 写路径监听），settings
        // 变更后需重启 dsh 生效；热重建会与 coordinator 的持久状态冲突。
        ctx.logger.warn("session-rdb: settings changed; restart to apply the new configuration");
      });
    }
    super(ctx);
    // Open asynchronously so connection setup (file creation / DB connect +
    // schema check) does not block plugin apply; every storage hook awaits the
    // same readiness promise.
    this.config = resolved;
    this.backend = injectedBackend ?? createBackend(resolved);
    this.ready = this.init();
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this);
    // 分支 provider 服务（闭环）：本包同时实现 session-persistence 与
    // session-branch（rewind / forkFrom / timeline）。Service 构造即注册
    // ctx.sessionBranch 并随 fiber 卸载自动回滚。
    new SessionBranchRdb(this.ctx);
    // 导入端点：webServer + connection 就绪后注册 `/api/session.import`
    // （zip → JSONL → 新 id 落库），与导出的 raw artifact 格式互为逆。
    registerSessionImport(this.ctx, this);
  }

  private async init(): Promise<void> {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }

  // --- SessionPersistence service surface (delegated to the coordinator) ---

  /** The backend has one database, not an independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  create(meta: SessionHeader, inheritedEventCount?: number): Promise<void> {
    return this.coordinator.create(
      meta,
      inheritedEventCount === undefined ? undefined : SessionLogOffset(inheritedEventCount),
    );
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  load(id: SessionId): Promise<import("@deepseek-ai/dsh-session-persistence").SessionInspection> {
    return this.coordinator.load(id);
  }

  inspect(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionInspection> {
    return this.coordinator.inspect(id, signal);
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionEventSuffix> {
    // 校验委托给 coordinator（其内部把非法 offset 转成 rejected promise）；
    // 这里只做品牌转换，避免 cordis proxy 下同步 throw 逃逸。
    return this.coordinator.readFrom(id, fromSeq as SessionLogOffset, signal);
  }

  /**
   * Borrow one exact logical view while pinning its reusable prepared Session.
   * Delegates to the coordinator (same semantics as the upstream sqlite backend).
   */
  override borrowSession(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal);
  }

  // --- PersistenceBackend hooks (the storage primitives) ---

  /** Read a stored prefix by id (ids are globally unique — no scope to scan). */
  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    return this.readPrefix(id, signal);
  }

  /**
   * Seek-capable suffix read: the backend selects `f_sequence >= fromSeq`
   * directly, so the read scales with the suffix, not the log. Provenance
   * remapping still needs every row's upstream seq, so a lightweight
   * two-column map is read alongside. Torn rows past the preserved region are
   * dropped, never repaired (non-mutating read).
   */
  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    const log = await this.readLog(id, { fromSeq }, signal);
    if (log === undefined) return undefined;
    return {
      meta: log.meta,
      inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
      events: log.events,
    };
  }

  /**
   * Read a session's row + ordered events into a {@link StoredPrefix}. The
   * torn-tail marker is the persisted seq from which a never-committed tail
   * must be deleted (`scanRows` already returns it as `number | undefined`).
   * Records the confirmed dense head (or confirmed absence) so a later
   * `appendBatch` can detect a second writer that advanced the log.
   */
  private async readPrefix(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<number> | undefined> {
    const log = await this.readLog(id, {}, signal);
    if (log === undefined) {
      // Confirmed absence: a fresh session this instance has read about. A
      // later append to a session that meanwhile got a row must reject.
      this.writeGuard.confirmHead(id, -1);
      return undefined;
    }
    // The confirmed head is the last PRESERVED seq (a torn tail is removed by
    // the caller's commitRepair, which re-confirms the head after repair).
    this.writeGuard.confirmHead(id, log.events.at(-1)?.seq ?? -1);
    // 全量读取时对 replace 事件重计算 provenance（sourceEventSeqs 不落库；
    // 上游 Session seed 校验要求 replace 的 provenance 覆盖其 range 内全部
    // surface 节点，见 {@link recomputeReplaceProvenance}）。
    recomputeReplaceProvenance(log.events);
    return {
      meta: log.meta,
      inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
      events: log.events,
      // The revision must identify exactly these values and match
      // readStoredRevision's representation (see listSnapshots).
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${log.incarnation}:revision:${log.revision}`,
      ),
      ...(log.tornFrom !== undefined ? { tornMarker: log.tornFrom } : {}),
    };
  }

  /**
   * Read the current source-qualified revision for one stored session without
   * loading its event log. Returns `undefined` when the identity is absent.
   * The representation matches {@link loadStored}'s `revision` and
   * {@link listSnapshots} — the coordinator compares them with `===`.
   */
  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    return SessionPersistenceRevision(
      `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`,
    );
  }

  /**
   * Shared read pipeline: session row → meta, event rows → preserved prefix.
   * A whole-log read (`fromSeq` absent) builds the seq map from the same rows;
   * a suffix read keeps the backend's lightweight two-column seq-map source so
   * the query still scales with the suffix, not the log.
   */
  private async readLog(
    id: SessionId,
    options: { fromSeq?: number } = {},
    signal?: AbortSignal,
  ): Promise<
    | {
        meta: SessionHeader;
        /** 继承前缀长度（`meta.isSeeded` 时非零；否则 0）。 */
        inheritedEventCount: number;
        events: SessionEvent[];
        tornFrom?: number;
        /** The session row's stable identity (see {@link listSnapshots}). */
        incarnation: string;
        /** The session row's monotonic log-change token. */
        revision: number;
      }
    | undefined
  > {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    const meta = rowToMeta(row);
    let eventRows: EventRow[];
    let seqMap: ReadonlyMap<number, number>;
    if (options.fromSeq === undefined) {
      // Whole-log read: build the seq map from the same rows (no extra query).
      eventRows = await this.backend.getEventRows(id);
      seqMap = buildSeqMap(eventRows);
    } else {
      // Suffix read: rows are only the suffix, but coordinate remapping needs
      // every row's upstream seq, so a lightweight two-column map is read
      // alongside — the query still scales with the suffix.
      eventRows = await this.backend.getEventRows(id, options.fromSeq);
      const seqRows = await this.backend.getSeqMapRows(id);
      seqMap = buildSeqMap(seqRows);
    }
    signal?.throwIfAborted();
    const { preserved, tornFrom } = scanRows(eventRows, options.fromSeq ?? 0, seqMap);
    return {
      meta,
      inheritedEventCount: row.fSeedLength ?? 0,
      events: preserved,
      incarnation: row.fIncarnation,
      revision: row.fRevision,
      ...(tornFrom !== undefined ? { tornFrom } : {}),
    };
  }

  /**
   * Durably append a batch in ONE transaction: materialize the sessions row (if
   * lazy) and INSERT every persisted event (plus its bridge row), or roll back
   * entirely. Delta events and events the writer marked `ignorable` are dropped
   * and the surviving events are re-numbered densely from the session's head
   * cursor; a batch that contains only dropped events is a no-op (no row
   * materialization, no revision bump). 写路径零转换：`f_data` 完整原始 data、
   * `f_surface_op` 原始坐标原样落库（坐标转换集中在读取路径，经桥接行
   * `f_original_seq` 映射）。
   * The transaction is the atomicity + durability boundary, so a mid-batch
   * failure (a UNIQUE violation on a duplicated seq) leaves the stored log
   * untouched.
   *
   * SQLite acquires the write lock up front (`BEGIN IMMEDIATE`, queued behind
   * `busy_timeout`); PostgreSQL relies on the transaction's row locks and the
   * `UNIQUE (f_session_id, f_sequence)` constraint to reject a colliding batch.
   * Either way {@link assertNoConcurrentWriter} rejects a second writer before
   * re-numbering — a session has exactly one writer per log, and a second
   * writer fails loud instead of corrupting the log.
   *
   * The row upsert runs UNCONDITIONALLY, not only when `!isMaterialized`: a
   * delta-only batch leaves the coordinator's materialized flag true while no
   * row exists, so the flag cannot be trusted as the row's existence signal.
   * The upsert keeps an existing row's head cursor (only header columns are
   * refreshed on conflict), so a fresh row still starts at the initial head.
   */
  async appendBatch(
    storage: SessionStorageMetadata,
    events: readonly SessionEvent[],
    _isMaterialized: boolean,
  ): Promise<void> {
    await this.ready;
    const persisted = events.filter(isPersistedEvent);
    if (persisted.length === 0) return;
    const meta = storage.meta;
    // fork 派生会话的 seed 复用源会话事件行（不复制）；消费后清除。
    const reuse = this.reuseEventIds.get(meta.id);
    if (reuse !== undefined) this.reuseEventIds.delete(meta.id);
    let confirmedHead = -1;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(storage, randomUUID());
      const head = await tx.getHead(meta.id);
      // Reject a second writer BEFORE re-numbering: each coordinator instance
      // maintains its own upstream cursor, so a second instance (or process)
      // sharing this database would append through a stale view of the log —
      // the batch's events would be silently re-numbered onto the other
      // writer's tail and corrupt the log. The on-disk head must equal the
      // last head this instance confirmed (via its own writes or loadStored).
      this.writeGuard.assertNoConcurrentWriter(meta.id, head.fHeadSequence);
      const { headEventId, headSequence } = await appendEventTail(
        tx,
        meta,
        persisted,
        { parentId: head.fHeadEventId, nextSeq: head.fHeadSequence + 1 },
        reuse,
      );
      await tx.updateHead(meta.id, headEventId, headSequence);
      await tx.bumpRevision(meta.id);
      confirmedHead = headSequence;
    });
    // Confirm the new head only after the commit: a rollback must not leave
    // a confirmed head this instance did not actually write.
    this.writeGuard.confirmHead(meta.id, confirmedHead);
  }

  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`), rewind the head cursor to the last surviving event, INSERT
   * the synthetic `closers`, and bump the revision once. After COMMIT the
   * stored rows == the balanced log.
   */
  async commitRepair(
    storage: SessionStorageMetadata,
    tornMarker: number | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    await this.ready;
    const meta = storage.meta;
    const persistedClosers = closers.filter(isPersistedEvent);
    if (tornMarker === undefined && persistedClosers.length === 0) return;
    await this.backend.transaction(async (tx) => {
      if (tornMarker !== undefined) {
        await tx.deleteBridgeTail(meta.id, tornMarker);
        // The head cursor rewinds to the last surviving event (or the initial
        // state when the torn tail started at seq 0).
        const prev = await tx.getPrevBridge(meta.id, tornMarker - 1);
        if (prev === undefined) {
          await tx.updateHead(meta.id, "", -1);
        } else {
          await tx.updateHead(meta.id, prev.fEventId, prev.fSequence);
        }
      }
      if (persistedClosers.length > 0) {
        // Anchor at the ACTUAL tail row: the head cursor can lag the rows (a
        // hand-written torn tail never updated it), so a closer must follow the
        // last physical row, not the cursor.
        const last = await tx.getLastBridge(meta.id);
        const { headEventId, headSequence } = await appendEventTail(tx, meta, persistedClosers, {
          parentId: last?.fEventId ?? "",
          nextSeq: (last?.fSequence ?? -1) + 1,
        });
        await tx.updateHead(meta.id, headEventId, headSequence);
      }
      await tx.bumpRevision(meta.id);
    });
    // Re-confirm the head AFTER repair: truncation can rewind it and the
    // closers advance it, and the next append must not be rejected (or worse,
    // silently re-numbered) against a stale confirmation.
    const row = await this.backend.getSession(meta.id);
    this.writeGuard.confirmHead(meta.id, row?.fHeadSequence ?? -1);
  }

  /**
   * 一次性清洗一个 session 的旧格式数据到新格式（迁移，最后做）。
   *
   * 旧数据（本设计之前的代码写入）的特征：`t_events` 带 `f_source_event_seqs` /
   * `f_surface_op` 列（上游坐标 provenance 落库）、`f_original_seq` 在事件行、
   * `f_kind` 语义为「= 上游 type」。迁移目标（与新格式一致）：
   * - `f_original_seq` 保留（语义 = 上游值，与新格式相同）——从 `t_events`
   *   迁移到 `t_session_events` 桥接行；
   * - `surfaceOp` 迁移到桥接行 `f_surface_op`，保持原始坐标（写路径零转换
   *   原则——不转稠密坐标，读取时经 `f_original_seq` 映射重映射）；
   * - `sourceEventSeqs` 丢弃（不落库语义）；
   * - `turn`/`step` 留在 `f_data`（完整原始 data 语义，不剥离）；
   * - `f_kind` 重算为事件种类（message/thinking 按 content 块归类）。
   * 事务内完成——中途失败整体回滚，不留混合格式。返回实际变更的事件数。
   */
  async cleanseSession(id: SessionId, signal?: AbortSignal): Promise<{ changed: number }> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const eventRows = await this.backend.getEventRows(id);
    if (eventRows.length === 0) return { changed: 0 };
    const seqMap = buildSeqMap(eventRows);
    const { preserved } = scanRows(eventRows, 0, seqMap);
    recomputeReplaceProvenance(preserved);
    const bySeq = new Map(preserved.map((event) => [event.seq, event]));
    const updates: Array<{
      fSequence: number;
      fSurfaceOp?: string | null;
      fOriginalSeq?: number;
    }> = [];
    for (const row of eventRows) {
      const event = bySeq.get(SessionSeq(row.fSequence));
      if (event === undefined) continue; // torn tail fragment
      const surface = event as SessionEvent & { surfaceOp?: unknown };
      const newOp = surface.surfaceOp === undefined ? null : JSON.stringify(surface.surfaceOp);
      const fields: {
        fSurfaceOp?: string | null;
        fOriginalSeq?: number;
      } = {};
      if (newOp !== row.fSurfaceOp) fields.fSurfaceOp = newOp;
      if (row.fOriginalSeq !== row.fSequence) fields.fOriginalSeq = row.fSequence;
      if (Object.keys(fields).length > 0) {
        updates.push({ fSequence: row.fSequence, ...fields });
      }
    }
    if (updates.length === 0) return { changed: 0 };
    await this.backend.transaction(async (tx) => {
      for (const update of updates) {
        await tx.updateBridgeFields(id, update.fSequence, {
          ...(update.fSurfaceOp === undefined ? {} : { fSurfaceOp: update.fSurfaceOp }),
          ...(update.fOriginalSeq === undefined ? {} : { fOriginalSeq: update.fOriginalSeq }),
        });
      }
    });
    return { changed: updates.length };
  }

  /** List all materialized sessions' metadata (every row is a materialized session). */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    return rows.map(rowToMeta);
  }

  /**
   * List metadata with a source-qualified monotonic revision per session.
   * 每个快照额外携带 `inheritedEventCount`（继承前缀长度）——结构兼容上游
   * `SessionPersistenceSnapshot`，供 `@morlay/session-branch` 的版本树投影
   * 区分继承与自有后缀。
   */
  async listSnapshots(
    signal?: AbortSignal,
  ): Promise<Array<SessionPersistenceSnapshot & { inheritedEventCount: number }>> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    return rows.map((row) => ({
      header: rowToMeta(row),
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`,
      ),
      inheritedEventCount: row.fSeedLength ?? 0,
    }));
  }

  /** Close the database connection (awaited by the coordinator's dispose, post-drain). */
  async close(): Promise<void> {
    await this.ready;
    await this.backend.close();
  }

  /**
   * 注册 fork 派生会话的事件行复用映射：childId 的 seed 事件（上游 seq →
   * 源会话已存在事件行的 f_event_id）在 appendBatch 时复用，不复制事件行。
   * @internal 仅供 `SessionBranchRdbProvider.forkFrom` 使用。
   */
  registerReuseEventIds(childId: SessionId, map: ReadonlyMap<number, string>): void {
    this.reuseEventIds.set(childId, new Map(map));
  }

  /**
   * 同包分支 provider 的内部访问面（rewind / forkFrom 共享后端与写路径）。
   * @internal 仅供 `SessionBranchRdbProvider` 使用；不是公开 API。
   */
  internals(): SessionPersistenceRdbInternals {
    return {
      backend: this.backend,
      writeGuard: this.writeGuard,
      create: (meta, inheritedEventCount) => this.create(meta, inheritedEventCount),
      append: (id, events) => this.append(id, events),
      load: (id) => this.load(id),
      inspect: (id, signal) => this.inspect(id, signal),
      readFrom: (id, fromSeq, signal) => this.readFrom(id, fromSeq, signal),
      listSnapshots: (signal) => this.listSnapshots(signal),
      readStoredRevision: (id, signal) => this.readStoredRevision(id, signal),
      registerReuseEventIds: (childId, map) => this.registerReuseEventIds(childId, map),
    };
  }
}

/**
 * Build the configured backend. The PostgreSQL arm creates the `node-postgres`
 * pool here (its identity base comes from the parsed pool options); tests
 * inject a drizzle PG instance directly via {@link PostgresBackend}.
 */
function createBackend(config: Config): Backend {
  if (config.type === "sqlite") {
    return new SqliteBackend({
      path: config.path,
      journalMode: config.journalMode ?? "wal",
      busyTimeout: config.busyTimeout ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
  }
  const pool = new Pool({ connectionString: config.connectionString });
  // node-postgres 官方要求 Pool 必须监听 error：idle client 被服务器端
  // 切断（数据库重启、DROP DATABASE ... FORCE）时，未监听的 error 会以
  // uncaughtException 崩溃进程。池级错误会在下一次操作（query）处可见，
  // 这里只需消费事件，无需输出。
  pool.on("error", () => {});
  const db = drizzlePg({ client: pool });
  const identityBase = [
    "postgres",
    pool.options.host ?? "localhost",
    String(pool.options.port ?? 5432),
    pool.options.database ?? "",
    config.schema ?? "public",
  ].join(":");
  return new PostgresBackend(db, {
    identityBase,
    schema: config.schema ?? "public",
    close: () => pool.end(),
  });
}

/**
 * Durably append one batch of persisted events to a session's tail inside the
 * enclosing transaction: mint each event's row (parent chain + dimensions +
 * complete original data) and its bridge row (dense seq + upstream seq +
 * surface metadata), land both as ONE multi-row INSERT each (N events are 2
 * statements instead of 2N), and return the resulting head cursor.
 *
 * 写路径零转换：`f_data` 完整原始 data、`f_surface_op` 原始坐标原样落库；
 * `sourceEventSeqs` 不落库（读取时对 replace 事件重计算）。
 *
 * 事件行复用（fork 派生）：`reuse` 映射（上游 seq → 已存在事件行 id）命中时
 * 复用事件行（不复制、不 INSERT t_events），只插桥接行；未命中则 mint 新行。
 *
 * The anchor is the caller's responsibility: a normal append starts from the
 * head cursor (`head.fHeadEventId` / `head.fHeadSequence + 1`), while
 * crash-repair closers start from the ACTUAL tail row (the head cursor can lag
 * a hand-written torn tail). Both callers then persist the returned cursor via
 * {@link BackendTx.updateHead}.
 * @param tx - the enclosing transaction.
 * @param meta - the session being written (`meta.id` drives the bridge rows).
 * @param events - persisted events to append (callers already filtered out
 *   ephemeral/ignorable events; non-empty).
 * @param anchor - the parent event id to chain from and the next dense seq.
 * @param reuse - upstream seq → existing event id map (fork seed reuse), or
 *   undefined for ordinary appends.
 * @returns the new head cursor (last event id + its dense seq).
 */
async function appendEventTail(
  tx: BackendTx,
  meta: SessionHeader,
  events: readonly SessionEvent[],
  anchor: { parentId: string; nextSeq: number },
  reuse?: ReadonlyMap<number, string>,
): Promise<{ headEventId: string; headSequence: number }> {
  let parentId = anchor.parentId;
  let nextSeq = anchor.nextSeq;
  // Build both batches up front, then land them in ONE multi-row INSERT each:
  // N events are 2 statements instead of 2N (fewer SQLite statements and fewer
  // PostgreSQL round trips per commit).
  const eventRows: EventInsert[] = [];
  const bridgeRows: Array<{
    fSessionId: SessionId;
    fEventId: string;
    fSequence: number;
    fOriginalSeq: number;
    fSurfaceOp: string | null;
  }> = [];
  for (const event of events) {
    const reusedId = reuse?.get(event.seq);
    const eventId = reusedId ?? randomUUID();
    if (reusedId === undefined) {
      const { kind, role, name, actionId } = eventDimensions(event);
      eventRows.push({
        fEventId: eventId,
        fParentId: parentId,
        fType: event.type,
        fKind: kind,
        fRole: role,
        fName: name,
        fActionId: actionId,
        fEncoding: EVENT_ENCODING,
        fData: JSON.stringify(event.data),
        fCreatedAt: event.time,
      });
    }
    const surfaceOp =
      (event as SessionEvent<SurfaceEventType>).surfaceOp === undefined
        ? null
        : JSON.stringify((event as SessionEvent<SurfaceEventType>).surfaceOp);
    bridgeRows.push({
      fSessionId: meta.id,
      fEventId: eventId,
      fSequence: nextSeq,
      fOriginalSeq: event.seq,
      fSurfaceOp: surfaceOp,
    });
    parentId = eventId;
    nextSeq++;
  }
  if (eventRows.length > 0) await tx.insertEvents(eventRows);
  await tx.insertBridges(bridgeRows);
  return { headEventId: parentId, headSequence: nextSeq - 1 };
}

export default SessionPersistenceRdb;
