import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  assertContiguous,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SESSION_FORMAT_VERSION,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SurfaceEventType,
} from "@deepseek-ai/dsh-session";
import { sessionFormatLogFilename } from "@deepseek-ai/dsh-session-format";
import { type Backend, type BackendTx, type EventInsert } from "./backend.ts";
import { WriteGuard } from "./write-guard.ts";
import { repairReadView, rowToMeta, scanRows, toJsonlArtifact } from "./log.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  eventDimensions,
  EVENT_ENCODING,
  type JournalMode,
} from "./schema.ts";
import { SqliteBackend } from "./sqlite.ts";
import { PostgresBackend } from "./postgres.ts";
import { SessionBranchRdb } from "./branch.ts";
import { balanceRewindPrefix } from "@morlay/session-branch";
import { registerSessionImport } from "./import.ts";
import { registerSessionDeletion } from "./deletion.ts";
import { registerSessionExport } from "./export.ts";
import { registerSessionGc } from "./gc.ts";
import { SessionQueryRdb } from "./session-query.ts";
import { adoptLegacyRows, convertLegacyRows, isLegacyVersion } from "./legacy.ts";
import { installStorageTakeover } from "./storage-takeover/index.ts";

const DEFAULT_PROJECTION_WRITE_EVERY_EVENTS = 200;
const DEFAULT_PROJECTION_WRITE_INTERVAL_MS = 5000;

export { SCHEMA_VERSION } from "./schema.ts";
export { SessionBranchRdb, SessionBranchRdbProvider, locateTurnEnd } from "./branch.ts";

export interface SessionPersistenceRdbInternals {
  readonly backend: Backend;
  readonly writeGuard: WriteGuard;
  create(meta: SessionHeader, inheritedEventCount?: number): Promise<SessionHandle>;
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
  ): Promise<{ meta: SessionHeader; inheritedEventCount: number; events: readonly SessionEvent[] }>;
  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>;
  readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionPersistenceRevision | undefined>;

  registerReuseEventIds(childId: SessionId, map: ReadonlyMap<number, string>): void;
}

export interface ProjectionCacheOptions {
  writeEveryEvents?: number;

  writeIntervalMs?: number;
}

export type Config =
  | {
      type: "sqlite";

      path: string;

      journalMode?: JournalMode;

      busyTimeout?: number;

      projectionCache?: ProjectionCacheOptions;
    }
  | {
      type: "postgres";

      connectionString: string;

      schema?: string;

      projectionCache?: ProjectionCacheOptions;
    };

export type SessionDeletionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ARCHIVED"
  | "SESSION_LIVE";

export class SessionDeletionError extends Error {
  constructor(
    message: string,
    readonly code: SessionDeletionErrorCode,
  ) {
    super(message);
    this.name = "SessionDeletionError";
  }
}

interface PendingSession {
  readonly header: SessionHeader;
  readonly revision: SessionPersistenceRevision;
  readonly inheritedEventCount: SessionLogOffset;

  readonly cursor: number;

  readonly everAppended: boolean;
}

class RdbBackendTracker {
  private readonly writers = new Map<SessionId, RdbSessionHandle | null>();
  private readonly pending = new Map<SessionId, PendingSession>();
  private readonly openHandles = new Set<RdbSessionHandle>();
  private counter = 0;

  constructor(private readonly name: string) {}

  registerCreated(header: SessionHeader, inheritedEventCount: SessionLogOffset): void {
    if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id);
    this.writers.set(header.id, null);
    this.pending.set(header.id, {
      header,
      revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`),
      inheritedEventCount,
      cursor: 0,
      everAppended: false,
    });
  }

  updatePending(id: SessionId, cursor: number, everAppended: boolean): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.set(id, { ...entry, cursor, everAppended });
  }

  claimWrite(id: SessionId): void {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
    this.writers.set(id, null);
  }

  releaseClaim(id: SessionId): void {
    this.writers.delete(id);
  }

  pendingOf(id: SessionId): PendingSession | undefined {
    return this.pending.get(id);
  }

  hasPending(id: SessionId): boolean {
    return this.pending.has(id);
  }

  pendingEntries(): IterableIterator<[SessionId, PendingSession]> {
    return this.pending.entries();
  }

  materialized(id: SessionId): void {
    this.pending.delete(id);
  }

  adopt(handle: RdbSessionHandle): RdbSessionHandle {
    this.openHandles.add(handle);
    if (handle.access === "write") this.writers.set(handle.id, handle);
    return handle;
  }

  release(handle: RdbSessionHandle, materialized: boolean): void {
    this.openHandles.delete(handle);
    if (handle.access !== "write") return;
    this.writers.delete(handle.id);
    if (!materialized) this.pending.delete(handle.id);
  }

  writerOf(id: SessionId): RdbSessionHandle | undefined {
    const writer = this.writers.get(id);
    return writer === null ? undefined : writer;
  }

  hasOpenHandle(id: SessionId): boolean {
    for (const handle of this.openHandles) {
      if (handle.id === id) return true;
    }
    return false;
  }

  async flushAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const writer of this.writers.values()) {
      if (writer === null) continue;
      try {
        await writer.drainLive();
        await writer.flush();
      } catch (error: unknown) {
        if (error instanceof SessionHandleClosedError) continue;
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`);
  }

  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const handle of this.openHandles) {
      try {
        await handle.close();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} dispose failed`);
  }
}

class RdbSessionHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;

  private cursor: number;
  private materialized: boolean;

  private buffered: SessionEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private drainPaused = false;
  private draining: Promise<void> | undefined;

  private tornTruncateTo: number | undefined;

  private everAppended = false;

  constructor(
    private readonly persistence: SessionPersistenceRdb,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly state: {
      cursor: number;
      materialized: boolean;
      inheritedEventCount: SessionLogOffset;
      tornTruncateTo?: number;
    },
  ) {
    this.cursor = state.cursor;
    this.materialized = state.materialized;
    this.tornTruncateTo = state.tornTruncateTo;
  }

  get inheritedEventCount(): SessionLogOffset {
    return this.state.inheritedEventCount;
  }

  get cursorValue(): number {
    return this.cursor;
  }

  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen("read");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`);
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`);
    }
    options?.signal?.throwIfAborted();
    const log = await this.persistence.readLog(this.id, {}, options?.signal);
    if (log === undefined) {
      if (this.persistence.tracker.hasPending(this.id)) {
        return { eventState: "detached", events: [] };
      }
      throw new SessionPersistenceNotFoundError(this.id);
    }

    repairReadView(log.events);
    return { eventState: "detached", events: log.events.slice(offset, offset + length) };
  }

  async append(
    events: readonly SessionEvent[],
    options?: SessionHandleAppendOptions,
  ): Promise<void> {
    this.assertOpen("append");
    const batch = materializeAppendBatch(events);
    return this.run("append", async () => {
      options?.signal?.throwIfAborted();
      if (this.access !== "write") throw new SessionReadOnlyError(this.id, "append");
      if (batch.length === 0) return;
      this.everAppended = true;
      assertContiguous(this.id, batch, this.cursor);
      await this.persistence.appendBatch(
        this.header,
        this.state.inheritedEventCount,
        batch,
        this.tornTruncateTo,
      );
      this.tornTruncateTo = undefined;

      this.cursor += batch.length;
      this.materialized = true;
      this.persistence.tracker.updatePending(this.id, this.cursor, true);
    });
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.run("flush", async () => {
      options?.signal?.throwIfAborted();
      if (this.access !== "write") throw new SessionReadOnlyError(this.id, "flush");
      if (this.materialized) return;
      await this.persistence.materializeEmpty(this.header, this.state.inheritedEventCount);
      this.materialized = true;
    });
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      let drainFailure: unknown;
      for (;;) {
        try {
          await this.drainLive();
        } catch (error: unknown) {
          drainFailure = error;
          break;
        }
        await this.chain;
        if (this.buffered.length === 0) break;
      }
      await this.chain;
      const failures: Error[] = [];
      if (drainFailure !== undefined) {
        failures.push(
          drainFailure instanceof Error ? drainFailure : new Error(JSON.stringify(drainFailure)),
        );
      }
      this.persistence.tracker.release(this, this.materialized || this.everAppended);
      if (failures.length > 1)
        throw new AggregateError(failures, `session "${this.id}": close failed to drain`);
      if (failures[0] !== undefined) throw failures[0];
    })());
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event));
    if (this.batchTimer !== undefined || this.drainPaused) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.drainLive().catch(reportBackgroundFailure);
    }, RdbSessionHandle.LIVE_WRITE_BATCH_MAX_DELAY_MS);
  }

  resetAfterRewind(cursor: number, inheritedEventCount?: number): void {
    this.cursor = cursor;
    if (inheritedEventCount !== undefined) {
      (this.state as { inheritedEventCount: SessionLogOffset }).inheritedEventCount =
        SessionLogOffset(inheritedEventCount);
    }
  }

  drainLive(): Promise<void> {
    return (this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined;
    }));
  }

  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    this.drainPaused = false;
    while (this.buffered.length > 0) {
      await this.enqueueChain(async () => {
        const batch = this.buffered.splice(0);
        try {
          const fresh = batch.filter((event) => event.seq >= this.cursor);
          if (fresh.length === 0) return;
          for (const [index, event] of fresh.entries()) {
            if (event.seq !== this.cursor + index) {
              throw new Error(
                `append seq mismatch for "${this.id}": expected ${this.cursor + index} at index ${index}, got ${event.seq}`,
              );
            }
          }
          await this.persistence.appendBatch(
            this.header,
            this.state.inheritedEventCount,
            fresh,
            this.tornTruncateTo,
          );
          this.tornTruncateTo = undefined;
          this.cursor += fresh.length;
          this.materialized = true;
        } catch (error: unknown) {
          this.buffered = batch.concat(this.buffered);
          this.drainPaused = true;
          throw error;
        }
      });
    }
  }

  private enqueueChain(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op);
    this.chain = next.catch(() => {});
    return next;
  }

  private async run(operation: string, op: () => Promise<void>): Promise<void> {
    this.assertOpen(operation);
    return this.enqueueChain(async () => {
      this.assertOpen(operation);
      return op();
    });
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation);
  }

  static readonly LIVE_WRITE_BATCH_MAX_DELAY_MS = 200;
}

export class SessionPersistenceRdb extends SessionPersistence {
  static inject = ["sessions", "settings"];

  static Config: z<Config> = z.union([
    z.object({
      type: z.const("sqlite"),
      path: z.string().required(),
      journalMode: z.union(["wal", "delete", "truncate", "persist"] as const).default("wal"),
      busyTimeout: z.number().step(1).min(0).default(DEFAULT_BUSY_TIMEOUT_MS),
      projectionCache: z
        .object({
          writeEveryEvents: z.natural().min(1).default(DEFAULT_PROJECTION_WRITE_EVERY_EVENTS),
          writeIntervalMs: z.natural().min(1).default(DEFAULT_PROJECTION_WRITE_INTERVAL_MS),
        })
        .default({
          writeEveryEvents: DEFAULT_PROJECTION_WRITE_EVERY_EVENTS,
          writeIntervalMs: DEFAULT_PROJECTION_WRITE_INTERVAL_MS,
        }),
    }),
    z.object({
      type: z.const("postgres"),
      connectionString: z.string().required(),
      schema: z.string().default("public"),
      projectionCache: z
        .object({
          writeEveryEvents: z.natural().min(1).default(DEFAULT_PROJECTION_WRITE_EVERY_EVENTS),
          writeIntervalMs: z.natural().min(1).default(DEFAULT_PROJECTION_WRITE_INTERVAL_MS),
        })
        .default({
          writeEveryEvents: DEFAULT_PROJECTION_WRITE_EVERY_EVENTS,
          writeIntervalMs: DEFAULT_PROJECTION_WRITE_INTERVAL_MS,
        }),
    }),
  ]);

  static readonly settingsNs = "session-rdb";

  override readonly name = "session-rdb";

  readonly tracker = new RdbBackendTracker(this.name);

  private readonly backend: Backend;
  private storeIdentity!: string;
  private readonly ready: Promise<void>;

  private readonly writeGuard = new WriteGuard();

  private readonly reuseEventIds = new Map<SessionId, Map<number, string>>();

  private readonly liveBuffers = new Map<SessionId, SessionEvent[]>();
  private readonly liveReady = new Map<SessionId, Promise<void>>();

  constructor(
    ctx: Context,
    public config: Config,

    injectedBackend?: Backend,
  ) {
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
        ctx.logger.warn("session-rdb: settings changed; restart to apply the new configuration");
      });
    }
    super(ctx);

    this.config = resolved;
    this.backend = injectedBackend ?? createBackend(resolved);
    this.ready = this.init();
    this.installLiveRouting(ctx);

    new SessionBranchRdb(this.ctx);

    this.ctx.plugin(SessionQueryRdb, {});

    registerSessionImport(this.ctx, this);

    registerSessionDeletion(this.ctx, this);

    registerSessionExport(this.ctx, this);

    registerSessionGc(this.ctx, this);

    installStorageTakeover(this.ctx, {
      repository: this.backend.storage,
      ready: this.ready,
      projectionCache: {
        writeEveryEvents:
          this.config.projectionCache?.writeEveryEvents ?? DEFAULT_PROJECTION_WRITE_EVERY_EVENTS,
        writeIntervalMs:
          this.config.projectionCache?.writeIntervalMs ?? DEFAULT_PROJECTION_WRITE_INTERVAL_MS,
      },
    });
  }

  private async init(): Promise<void> {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }

  async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const snapshot = materializeCreateHeader(header);
    if (snapshot.isSeeded && options?.inheritedEventCount === undefined) {
      throw new TypeError("seeded session metadata requires an inherited event count");
    }
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0);
    if (!snapshot.isSeeded && inheritedEventCount !== 0) {
      throw new TypeError("unseeded session metadata inherited event count must be 0");
    }
    await this.ready;
    options?.signal?.throwIfAborted();
    if (
      this.tracker.hasPending(snapshot.id) ||
      (await this.backend.getSession(snapshot.id)) !== undefined
    ) {
      throw new SessionAlreadyExistsError(snapshot.id);
    }
    this.tracker.registerCreated(snapshot, inheritedEventCount);
    return this.tracker.adopt(
      new RdbSessionHandle(this, snapshot.id, snapshot, "write", {
        cursor: 0,
        materialized: false,
        inheritedEventCount,
      }),
    );
  }

  async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    await this.ready;
    options?.signal?.throwIfAborted();
    const pending = this.tracker.pendingOf(id);
    if (access === "read") {
      if (pending !== undefined) {
        return this.tracker.adopt(
          new RdbSessionHandle(this, id, pending.header, "read", {
            cursor: 0,
            materialized: false,
            inheritedEventCount: pending.inheritedEventCount,
          }),
        );
      }
      const log = await this.readLog(id, {}, options?.signal);
      if (log === undefined) throw new SessionPersistenceNotFoundError(id);

      repairReadView(log.events);

      validateStoredEvents(log.meta, log.events);
      return this.tracker.adopt(
        new RdbSessionHandle(this, id, log.meta, "read", {
          cursor: log.events.length,
          materialized: true,
          inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
        }),
      );
    }
    this.tracker.claimWrite(id);
    try {
      if (pending !== undefined) {
        return this.tracker.adopt(
          new RdbSessionHandle(this, id, pending.header, "write", {
            cursor: pending.cursor,
            materialized: false,
            inheritedEventCount: pending.inheritedEventCount,
          }),
        );
      }
      const log = await this.readLog(id, {}, options?.signal);
      if (log === undefined) throw new SessionPersistenceNotFoundError(id);
      repairReadView(log.events);
      validateStoredEvents(log.meta, log.events);

      if (log.migrated && log.events.length !== log.storedCount) {
        await this.rewriteMigratedLog(id, log);
      }

      this.writeGuard.confirmHead(id, log.events.at(-1)?.seq ?? -1);
      return this.tracker.adopt(
        new RdbSessionHandle(this, id, log.meta, "write", {
          cursor: log.events.length,
          materialized: true,
          inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
          ...(log.tornFrom !== undefined ? { tornTruncateTo: log.tornFrom } : {}),
        }),
      );
    } catch (error: unknown) {
      this.tracker.releaseClaim(id);
      throw error;
    }
  }

  flush(): Promise<void> {
    return this.tracker.flushAll();
  }

  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted();
    await this.ready;
    options?.signal?.throwIfAborted();
    const pending = this.tracker.pendingOf(id);
    if (pending !== undefined) {
      return { header: pending.header, revision: pending.revision };
    }
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    return {
      header: rowToMeta(row),
      revision: this.rowRevision(row),
    };
  }

  async list(
    options?: SessionPersistenceListOptions,
  ): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal;
    const snapshots: SessionPersistenceSnapshot[] = [];
    const listed = new Set<SessionId>();
    for (const [id, pending] of this.tracker.pendingEntries()) {
      snapshots.push({ header: pending.header, revision: pending.revision });
      listed.add(id);
    }
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    for (const row of rows) {
      if (listed.has(row.fSessionId as SessionId)) continue;
      snapshots.push({ header: rowToMeta(row), revision: this.rowRevision(row) });
    }
    return snapshots;
  }

  async deleteSession(id: SessionId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) {
      throw new SessionDeletionError(`session "${id}" not found`, "SESSION_NOT_FOUND");
    }
    if (row.fArchivedAt === null) {
      throw new SessionDeletionError(
        `session "${id}" is not archived; only archived sessions can be deleted`,
        "SESSION_NOT_ARCHIVED",
      );
    }
    if (this.tracker.hasPending(id) || this.tracker.hasOpenHandle(id)) {
      throw new SessionDeletionError(
        `session "${id}" is live; stop it before deleting`,
        "SESSION_LIVE",
      );
    }
    await this.unarchiveBeforeDeletion(id);
    await this.backend.transaction(async (tx) => {
      await tx.deleteSession(id);
    });
    this.liveBuffers.delete(id);
    this.liveReady.delete(id);
    this.reuseEventIds.delete(id);
  }

  /** GC 通道：回收已无桥接行引用的事件行（孤儿），返回删除行数。 */
  async collectOrphans(): Promise<number> {
    await this.ready;
    return this.backend.collectOrphans();
  }

  /** GC 通道：回收父已不存在的 subagent 会话（live 的跳过），返回删除的会话数。 */
  async collectOrphanSessions(): Promise<number> {
    await this.ready;
    const orphans = await this.backend.listOrphanSubagentSessions();
    const deletable = orphans.filter(
      (id) => !this.tracker.hasPending(id) && !this.tracker.hasOpenHandle(id),
    );
    if (deletable.length === 0) return 0;
    const deleted = await this.backend.transaction((tx) => tx.deleteSessions(deletable));
    for (const id of deletable) {
      this.liveBuffers.delete(id);
      this.liveReady.delete(id);
      this.reuseEventIds.delete(id);
    }
    return deleted;
  }

  /** GC 通道：VACUUM；调用方需先停止运行中的写路径（见 `registerSessionGc`）。 */
  async vacuum(): Promise<void> {
    await this.ready;
    await this.backend.vacuum();
  }

  private async unarchiveBeforeDeletion(id: SessionId): Promise<void> {
    const registry = this.ctx.get("workspaceRegistry") as unknown as
      | {
          readonly archivedSessionIds: readonly SessionId[];
          unarchiveSession(sessionId: SessionId): Promise<void>;
        }
      | undefined;
    if (registry === undefined) return;
    if (!registry.archivedSessionIds.includes(id)) return;
    await registry.unarchiveSession(id);
  }

  async readRaw(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<
    | { meta: SessionHeader; inheritedEventCount: number; filename: string; content: string }
    | undefined
  > {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const log = await this.readLog(id, {}, signal);
    if (log === undefined) return undefined;
    repairReadView(log.events);
    // 整段日志导出：只丢弃「已不平衡」之后的尾部（尾部未闭合的 step 是中断运行的正常形状，由上游 resume 补 closers）
    const events = balanceRewindPrefix(log.events, { keepOpenTail: true });
    const inheritedEventCount = Math.min(log.inheritedEventCount, events.length);
    return {
      meta: log.meta,
      inheritedEventCount,

      filename: sessionFormatLogFilename(SESSION_FORMAT_VERSION),
      content: toJsonlArtifact(log.meta, inheritedEventCount, events),
    };
  }

  async materializeEmpty(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    await this.ready;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession({ meta, inheritedEventCount }, randomUUID());
      await tx.bumpRevision(meta.id);
    });
    this.tracker.materialized(meta.id);
    this.writeGuard.confirmHead(meta.id, -1);
  }

  async appendBatch(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
    tornTruncateTo?: number,
  ): Promise<boolean> {
    await this.ready;
    if (events.length === 0) return false;

    validateStoredEvents(meta, [...events]);

    const reuse = this.reuseEventIds.get(meta.id);
    if (reuse !== undefined) this.reuseEventIds.delete(meta.id);
    let confirmedHead = -1;
    await this.backend.transaction(async (tx) => {
      if (tornTruncateTo !== undefined) {
        await tx.deleteBridgeTail(meta.id, tornTruncateTo);
        const prev = await tx.getPrevBridge(meta.id, tornTruncateTo - 1);
        if (prev === undefined) {
          await tx.updateHead(meta.id, "", -1);
        } else {
          await tx.updateHead(meta.id, prev.fEventId, prev.fSequence);
        }
      }
      await tx.upsertSession({ meta, inheritedEventCount }, randomUUID());
      const head = await tx.getHead(meta.id);

      this.writeGuard.assertNoConcurrentWriter(meta.id, head.fHeadSequence);
      const { headEventId, headSequence } = await appendEventTail(
        tx,
        meta,
        events,
        { parentId: head.fHeadEventId, nextSeq: head.fHeadSequence + 1 },
        reuse,
      );
      await tx.updateHead(meta.id, headEventId, headSequence);
      await tx.bumpRevision(meta.id);
      confirmedHead = headSequence;
    });

    this.writeGuard.confirmHead(meta.id, confirmedHead);
    this.tracker.materialized(meta.id);
    return true;
  }

  async readLog(
    id: SessionId,
    options: { fromSeq?: number } = {},
    signal?: AbortSignal,
  ): Promise<
    | {
        meta: SessionHeader;

        inheritedEventCount: number;
        events: SessionEvent[];
        tornFrom?: number;

        incarnation: string;

        revision: number;

        storedCount: number;

        migrated: boolean;
      }
    | undefined
  > {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    const meta = rowToMeta(row);
    const eventRows =
      options.fromSeq === undefined
        ? await this.backend.getEventRows(id)
        : await this.backend.getEventRows(id, options.fromSeq);
    signal?.throwIfAborted();

    if (isLegacyVersion(row.fVersion)) {
      try {
        const converted = convertLegacyRows(row, eventRows);
        return {
          meta: converted.meta,
          inheritedEventCount: converted.inheritedEventCount,
          events: converted.events,
          incarnation: row.fIncarnation,
          revision: row.fRevision,
          storedCount: eventRows.length,
          migrated: true,
        };
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `session-rdb: session "${id}" is not a single released format; adopting its stored rows as current-format data (${error instanceof Error ? error.message : String(error)})`,
        );
        const adopted = adoptLegacyRows(row, eventRows);
        return {
          meta: adopted.meta,
          inheritedEventCount: adopted.inheritedEventCount,
          events: adopted.events,
          incarnation: row.fIncarnation,
          revision: row.fRevision,
          storedCount: eventRows.length,
          migrated: false,
          ...(adopted.tornFrom !== undefined ? { tornFrom: adopted.tornFrom } : {}),
        };
      }
    }
    const { preserved, tornFrom } = scanRows(eventRows, options.fromSeq ?? 0);
    return {
      meta,
      inheritedEventCount: row.fSeedLength ?? 0,
      events: preserved,
      incarnation: row.fIncarnation,
      revision: row.fRevision,
      storedCount: eventRows.length,
      migrated: false,
      ...(tornFrom !== undefined ? { tornFrom } : {}),
    };
  }

  private async rewriteMigratedLog(
    id: SessionId,
    log: { meta: SessionHeader; inheritedEventCount: number; events: SessionEvent[] },
  ): Promise<void> {
    await this.backend.transaction(async (tx) => {
      await tx.deleteBridgeTail(id, 0);
      await tx.upsertSession(
        { meta: log.meta, inheritedEventCount: SessionLogOffset(log.inheritedEventCount) },
        randomUUID(),
      );
      const { headEventId, headSequence } = await appendEventTail(tx, log.meta, log.events, {
        parentId: "",
        nextSeq: 0,
      });
      await tx.updateHead(id, headEventId, headSequence);
      await tx.bumpRevision(id);
    });
  }

  async listSnapshots(
    signal?: AbortSignal,
  ): Promise<Array<SessionPersistenceSnapshot & { inheritedEventCount: number }>> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const snapshots: Array<SessionPersistenceSnapshot & { inheritedEventCount: number }> = [];
    const listed = new Set<SessionId>();
    for (const [id, pending] of this.tracker.pendingEntries()) {
      snapshots.push({
        header: pending.header,
        revision: pending.revision,
        inheritedEventCount: pending.inheritedEventCount,
      });
      listed.add(id);
    }
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    for (const row of rows) {
      if (listed.has(row.fSessionId as SessionId)) continue;
      snapshots.push({
        header: rowToMeta(row),
        revision: this.rowRevision(row),
        inheritedEventCount: row.fSeedLength ?? 0,
      });
    }
    return snapshots;
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    return this.rowRevision(row);
  }

  async createAndAppend(
    header: SessionHeader,
    events: readonly SessionEvent[],
    inheritedEventCount?: number,
  ): Promise<void> {
    const handle = await this.create(
      header,
      inheritedEventCount === undefined
        ? undefined
        : { inheritedEventCount: SessionLogOffset(inheritedEventCount) },
    );
    try {
      if (events.length > 0) await handle.append(events);
    } finally {
      await handle.close();
    }
  }

  async load(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionInspection> {
    const handle = await this.open(id, "read", signal === undefined ? undefined : { signal });
    try {
      const { events } = await handle.read(
        0,
        undefined,
        signal === undefined ? undefined : { signal },
      );
      const row = await this.backend.getSession(id);
      if (row === undefined) throw new SessionPersistenceNotFoundError(id);

      if (isLegacyVersion(row.fVersion)) {
        return {
          meta: handle.header,
          inheritedEventCount: handle.inheritedEventCount,
          events,
        };
      }
      return {
        meta: rowToMeta(row),
        inheritedEventCount: SessionLogOffset(row.fSeedLength ?? 0),
        events,
      };
    } finally {
      await handle.close();
    }
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const handle = await this.open(id, "write");
    try {
      await handle.append(events);
    } finally {
      await handle.close();
    }
  }

  async readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{
    meta: SessionHeader;
    inheritedEventCount: number;
    events: readonly SessionEvent[];
  }> {
    const log = await this.readLog(id, { fromSeq }, signal);
    if (log === undefined) throw new SessionPersistenceNotFoundError(id);
    return {
      meta: log.meta,
      inheritedEventCount: log.inheritedEventCount,
      events: log.events,
    };
  }

  async close(): Promise<void> {
    await this.ready;
    await this.backend.close();
  }

  registerReuseEventIds(childId: SessionId, map: ReadonlyMap<number, string>): void {
    this.reuseEventIds.set(childId, new Map(map));
  }

  internals(): SessionPersistenceRdbInternals {
    return {
      backend: this.backend,
      writeGuard: this.writeGuard,
      create: (meta, inheritedEventCount) =>
        this.create(
          meta,
          inheritedEventCount === undefined
            ? undefined
            : { inheritedEventCount: SessionLogOffset(inheritedEventCount) },
        ),
      append: (id, events) => this.append(id, events),
      load: (id) => this.load(id),
      inspect: (id, signal) => this.load(id, signal),
      readFrom: (id, fromSeq, signal) => this.readFrom(id, fromSeq, signal),
      listSnapshots: (signal) => this.listSnapshots(signal),
      readStoredRevision: (id, signal) => this.readStoredRevision(id, signal),
      registerReuseEventIds: (childId, map) => this.registerReuseEventIds(childId, map),
    };
  }

  private rowRevision(row: import("./backend.ts").SessionRow): SessionPersistenceRevision {
    return SessionPersistenceRevision(
      `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`,
    );
  }

  private installLiveRouting(ctx: Context): void {
    ctx.on("session/created", (session: Session) => {
      this.liveBuffers.set(session.id, []);
      const ready = this.ensureLiveHandle(session);
      this.liveReady.set(session.id, ready);
      void ready.catch((error: unknown) => {
        ctx.logger.warn(
          `session-rdb: live session "${session.id}" persistence init failed: ${String(error)}`,
        );
      });
    });

    for (const session of ctx.sessions.list()) {
      this.liveBuffers.set(session.id, []);
      const ready = this.ensureLiveHandle(session);
      this.liveReady.set(session.id, ready);
      void ready.catch((error: unknown) => {
        ctx.logger.warn(
          `session-rdb: live session "${session.id}" persistence init failed: ${String(error)}`,
        );
      });
    }
    ctx.on("session/event", (session: Session, event: SessionEvent) => {
      const handle = this.tracker.writerOf(session.id);
      if (handle !== undefined) {
        handle.enqueueLive(event, (error) => {
          ctx.logger.warn(
            `session-rdb: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`,
          );
        });
        return;
      }
      this.liveBuffers.get(session.id)?.push(structuredClone(event));
    });
    ctx.on("session/flush", (session: Session) => {
      const handle = this.tracker.writerOf(session.id);
      if (handle === undefined) {
        const ready = this.liveReady.get(session.id);
        if (ready === undefined) return undefined;
        return ready.then(() => {
          const settled = this.tracker.writerOf(session.id);
          if (settled === undefined) return undefined;
          return settled.drainLive().then(() => settled.flush());
        });
      }
      return handle.drainLive().then(() => handle.flush());
    });
    ctx.on("session/disposed", (session: Session) => {
      const ready = this.liveReady.get(session.id);
      this.liveBuffers.delete(session.id);
      this.liveReady.delete(session.id);
      const closeHandle = (): void => {
        const handle = this.tracker.writerOf(session.id);
        if (handle === undefined) return;
        handle.close().catch((error: unknown) => {
          ctx.logger.warn(
            `session-rdb: final drain for session "${session.id}" failed: ${String(error)}`,
          );
        });
      };
      if (ready === undefined) {
        closeHandle();
        return;
      }

      void ready.then(closeHandle, closeHandle);
    });
    ctx.effect(
      () => async () => {
        await Promise.allSettled(this.liveReady.values());
        await this.tracker.closeAll();

        await this.close();
      },
      `${this.name} open handles`,
    );
  }

  private async ensureLiveHandle(session: Session): Promise<void> {
    const id = session.header.id;
    if (this.tracker.writerOf(id) !== undefined) return;
    await this.ready;
    const stored = await this.readLog(id, {});
    let handle: RdbSessionHandle;
    if (stored === undefined) {
      handle = (await this.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
      })) as RdbSessionHandle;
      const seed = session.snapshotEvents();
      if (seed.length > 0) await handle.append(seed);
    } else {
      if (stored.meta.cwd !== session.header.cwd) {
        throw new Error(
          `session "${id}" is already persisted at a different cwd (persisted: ${String(stored.meta.cwd)}, live: ${String(session.header.cwd)}) (id collision)`,
        );
      }
      if (stored.inheritedEventCount !== session.inheritedEventCount) {
        throw new Error(
          `session "${id}" is already persisted with a different inherited event count (id collision)`,
        );
      }
      assertVersion(stored.meta);

      repairReadView(stored.events);
      const seed = session.snapshotEvents();
      if (!seedCoversPrefix(seed, stored.events)) {
        throw new Error(
          `session "${id}" already has a persisted log on disk that does not match this live session (id collision)`,
        );
      }
      handle = (await this.open(id, "write")) as RdbSessionHandle;

      const suffix = seed.slice(stored.events.length);
      if (suffix.length > 0) await handle.append(suffix);
    }

    const buffered = this.liveBuffers.get(id);
    if (buffered !== undefined && buffered.length > 0) {
      this.liveBuffers.set(id, []);
      for (const event of buffered) {
        handle.enqueueLive(event, () => {});
      }
    }
  }
}

function seedCoversPrefix(seed: readonly SessionEvent[], prefix: readonly SessionEvent[]): boolean {
  return (
    prefix.length <= seed.length &&
    prefix.every((event, index) => {
      const seedEvent = seed[index];
      return seedEvent !== undefined && JSON.stringify(seedEvent) === JSON.stringify(event);
    })
  );
}

function createBackend(config: Config): Backend {
  if (config.type === "sqlite") {
    return new SqliteBackend({
      path: config.path,
      journalMode: config.journalMode ?? "wal",
      busyTimeout: config.busyTimeout ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
  }
  const pool = new Pool({ connectionString: config.connectionString });

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

async function appendEventTail(
  tx: BackendTx,
  meta: SessionHeader,
  events: readonly SessionEvent[],
  anchor: { parentId: string; nextSeq: number },
  reuse?: ReadonlyMap<number, string>,
): Promise<{ headEventId: string; headSequence: number }> {
  let parentId = anchor.parentId;
  let nextSeq = anchor.nextSeq;

  const eventRows: EventInsert[] = [];
  const bridgeRows: Array<{
    fSessionId: SessionId;
    fEventId: string;
    fSequence: number;
    fSurfaceOp: string | null;
  }> = [];
  for (const event of events) {
    const reusedId = reuse?.get(event.seq);
    const eventId = reusedId ?? randomUUID();
    if (reusedId === undefined) {
      const { kind, role, name, actionId } = eventDimensions(event);

      const raw = event as SessionEvent & {
        ignorable?: unknown;
        surfaceOp?: unknown;
        sourceEventSeqs?: unknown;
      };
      const { data, surfaceOp: _surfaceOp, sourceEventSeqs: _sourceEventSeqs, ...envelope } = raw;
      eventRows.push({
        fEventId: eventId,
        fParentId: parentId,
        fType: event.type,
        fKind: kind,
        fRole: role,
        fName: name,
        fActionId: actionId,
        fEncoding: EVENT_ENCODING,
        fData: JSON.stringify({ ...envelope, data }),
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
      fSurfaceOp: surfaceOp,
    });
    parentId = eventId;
    nextSeq++;
  }
  if (eventRows.length > 0) await tx.insertEvents(eventRows);
  await tx.insertBridges(bridgeRows);

  if (events.some((event) => (event.type as string) === "session/title")) {
    await tx.refreshTitle(meta.id);
  }
  return { headEventId: parentId, headSequence: nextSeq - 1 };
}

export default SessionPersistenceRdb;
