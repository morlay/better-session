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
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SurfaceEventType,
} from "@deepseek-ai/dsh-session";
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
import { registerSessionImport } from "./import.ts";
import { adoptLegacyRows, convertLegacyRows, isLegacyVersion } from "./legacy.ts";

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

export type Config =
  | {
      type: "sqlite";

      path: string;

      journalMode?: JournalMode;

      busyTimeout?: number;
    }
  | {
      type: "postgres";

      connectionString: string;

      schema?: string;
    };

/** 一个已创建但未 materialize 的会话（本进程可见，其他进程不可见）。 */
interface PendingSession {
  readonly header: SessionHeader;
  readonly revision: SessionPersistenceRevision;
  readonly inheritedEventCount: SessionLogOffset;
  /** 输入空间 cursor（全 delta 批次也推进）。 */
  readonly cursor: number;
  /** 是否调用过 append（close 时保留 pending）。 */
  readonly everAppended: boolean;
}

/** 会话级写所有权与 live 路由簿记。 */
class RdbBackendTracker {
  /** 每个 id 的活跃 write handle；`null` 表示 claim 构造中。 */
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

  /** 更新 pending 的 cursor / everAppended（handle append 后同步）。 */
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

/** 一个打开会话的存储句柄：read / append / flush / close。 */
class RdbSessionHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  /** 稠密 next-seq（输入空间计数，与旧版 coordinator cursor 同语义）。 */
  private cursor: number;
  private materialized: boolean;
  /** live 路由缓冲（上游 seq 事件，drain 时过滤 delta 后重编号稠密）。 */
  private buffered: SessionEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private drainPaused = false;
  private draining: Promise<void> | undefined;
  /** write open 时发现的 torn tail 起点（append 前先截断）。 */
  private tornTruncateTo: number | undefined;
  /** 是否调用过 append（即使全 delta 未落库）——close 时保留 pending。 */
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

  /** 输入空间 cursor（下一个待落库的上游 seq）。 */
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
    // 读取时修复（视图只读，不落库）：结算字段补全、非法 surface 替换降级
    // 或按 metering 数量夹取、metering range 对齐、provenance 重算、孤儿
    // inbox splice 改写。
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
      // 原样存储（与上游 JSONL 一致）：cursor 推进 batch.length，全部落库。
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

  /** live 路由：缓冲一个已发布事件（持久化自有副本），并启动批量窗口。 */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event));
    if (this.batchTimer !== undefined || this.drainPaused) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.drainLive().catch(reportBackgroundFailure);
    }, RdbSessionHandle.LIVE_WRITE_BATCH_MAX_DELAY_MS);
  }

  /** rewind 截断后对齐 handle 的稠密 cursor 与继承前缀（DB 已截断）。 */
  resetAfterRewind(cursor: number, inheritedEventCount?: number): void {
    this.cursor = cursor;
    if (inheritedEventCount !== undefined) {
      (this.state as { inheritedEventCount: SessionLogOffset }).inheritedEventCount =
        SessionLogOffset(inheritedEventCount);
    }
  }

  /** 排空 live 缓冲（过滤 delta + 重编号稠密 + append）。 */
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
          // 过滤已由 ensureLiveHandle 落库的 seed 前缀（上游 seq 空间，
          // 与 public append 的 cursor 同空间）。直接走持久化原语（本函数
          // 已在 chain 内，走 public append 会自锁）。
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
    }),
    z.object({
      type: z.const("postgres"),
      connectionString: z.string().required(),
      schema: z.string().default("public"),
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

  /** live 路由：session/created 后 handle 就绪前的缓冲。 */
  private readonly liveBuffers = new Map<SessionId, SessionEvent[]>();
  private readonly liveReady = new Map<SessionId, Promise<void>>();

  constructor(
    ctx: Context,
    public config: Config,

    injectedBackend?: Backend,
  ) {
    // settings.yaml 的 `session-rdb` namespace 覆盖 cordis 层 entry config；
    // settings 服务缺失时（纯 cordis 装配/测试）退化为 entry config。
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
        // 后端在构造时建成，settings 变更后需重启 dsh 生效。
        ctx.logger.warn("session-rdb: settings changed; restart to apply the new configuration");
      });
    }
    super(ctx);
    // 异步打开连接，避免阻塞插件 apply；存储钩子统一 await 同一个 readiness。
    this.config = resolved;
    this.backend = injectedBackend ?? createBackend(resolved);
    this.ready = this.init();
    this.installLiveRouting(ctx);
    // 分支 provider 服务（rewind / forkFrom / timeline），随 fiber 卸载自动回滚。
    new SessionBranchRdb(this.ctx);
    // 导入端点：webServer + connection 就绪后注册 `/api/session.import`。
    registerSessionImport(this.ctx, this);
  }

  private async init(): Promise<void> {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }

  // --- SessionPersistence service surface ---

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
      // fail-closed：未知事件类型（非 ignorable）拒绝解释。
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
      // pending（created 未 materialize）会话：write open 接管其所有权。
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
      validateStoredEvents(log.meta, log.events);
      // 迁移链会生成/合并事件（end-seed / attempt / chunk 合并），事件坐标与
      // 存储桥接行数不再相等——写打开时把迁移视图整体落库，使读写同坐标；
      // 否则 append 按存储 head 重编号会撞上已有行或写坏 log。
      if (log.migrated && log.events.length !== log.storedCount) {
        await this.rewriteMigratedLog(id, log);
      }
      // 确认 head：本实例已读该会话，后续 append 的并发校验以此为基准。
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

  // --- RDB 特有能力（rewind / fork / 导出 / 测试支撑） ---

  /** 导出 artifact（jsonl v2 文本），视图只读不落库。 */
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
    const inheritedEventCount = Math.min(log.inheritedEventCount, log.events.length);
    return {
      meta: log.meta,
      inheritedEventCount,
      filename: "session.jsonl",
      content: toJsonlArtifact(log.meta, inheritedEventCount, log.events),
    };
  }

  /** 空会话 materialize（flush 的持久化屏障）。 */
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

  /** 原样 append 落库（handle 已校验 contiguity；torn tail 先截断）。
   *  与上游 JSONL 一致：ignorable 事件原样存储，不做过滤。写路径校验 v2
   *  形状（fail-closed）：未知类型（非 ignorable）与非法消息形状拒绝入库；
   *  旧格式（v0/v1）数据只在读取时经 legacy 转换链动态转换，不落新库。 */
  async appendBatch(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
    tornTruncateTo?: number,
  ): Promise<boolean> {
    await this.ready;
    if (events.length === 0) return false;
    // 写路径 v2 校验：与读路径同契约（validateStoredEvents），保证新入库
    // 数据只能是 v2 形状。拷贝避免 adopt 替换污染调用方数组。
    validateStoredEvents(meta, [...events]);
    // fork 派生会话的 seed 复用源会话事件行（不复制）；消费后清除。
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
      // 重编号前拒绝第二个写入者：多实例共享数据库时，第二个写入者经陈旧
      // 视图 append 会把事件静默重编号到对方尾部、损坏 log。磁盘 head 必须
      // 等于本实例确认过的最后一个 head。
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
    // 提交后才确认新 head：回滚不得留下本实例实际未写的已确认 head。
    this.writeGuard.confirmHead(meta.id, confirmedHead);
    this.tracker.materialized(meta.id);
    return true;
  }

  /** 读取一个会话的稠密 log（含 torn tail 检测，不含修复改写）。 */
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

        /** 存储桥接行数（迁移链可能生成/合并事件，与 `events.length` 不同）。 */
        storedCount: number;

        /** 是否经上游迁移链转换（v0/v1 → 当前格式）。 */
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
    // 旧格式（v0/v1）历史数据：行重建为物理记录，经上游迁移链转 v2 逻辑事件。
    // 迁移链自带 seq gap / torn tail 校验（strict recovery），无需 scanRows。
    // 混合世代 log（旧写入器跨上游版本追加）不是任何单一已发布格式，迁移链
    // 必然拒绝——回退为当前格式视图（header 版本归一 + 读取视图修复）。
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

  /**
   * 把迁移链读出的 v2 视图整体落库（旧格式会话写打开时的一次性迁移）。
   *
   * 迁移链会生成/合并事件（end-seed / attempt / chunk 合并），事件 seq 空间
   * 与存储桥接行数不再相等；写路径以存储 head 为锚点重编号，二者不一致会让
   * append 撞上已有行。这里在同一事务内删光本会话桥接行、按迁移视图重建
   * （新事件行，完整信封），并更新 head 与 revision；旧事件行保留（可能被
   * fork 子会话引用，孤儿由惰性 GC 处理）。
   */
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

  /** 便捷：create + append + close（测试与导入路径共用）。 */
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

  /** 便捷：open(read) + read 全量 + close。 */
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
      // 旧格式（v0/v1）会话：meta 与继承前缀来自转换链（handle.header 已是
      // 转换后的 v2 header）；v2 会话用存储行。
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

  /** 便捷：open(write) + append + close。 */
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const handle = await this.open(id, "write");
    try {
      await handle.append(events);
    } finally {
      await handle.close();
    }
  }

  /** 便捷：readFrom（稠密后缀）。 */
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

  // --- live 路由：session/created → create/adopt handle；event → 缓冲；flush → drain ---

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
    // HMR：插件 apply 时已存在的 live 会话不重放 session/created——补种。
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
      // handle 可能仍在构造（ensureLiveHandle 异步）：等就绪后再 close。
      void ready.then(closeHandle, closeHandle);
    });
    ctx.effect(
      () => async () => {
        // 先等所有 live handle 就绪（ensureLiveHandle 异步），再统一关闭。
        await Promise.allSettled(this.liveReady.values());
        await this.tracker.closeAll();
        // 等 init（异步 open）settle 后关闭后端连接：dispose 返回后调用方
        // 可能立即释放存储（pg 测试 drop 数据库），未完成的 open 会以
        // 无人处理的 rejection 泄漏。
        await this.close();
      },
      `${this.name} open handles`,
    );
  }

  /** session/created 后为 live 会话建立 write handle（create 或 adopt）。 */
  private async ensureLiveHandle(session: Session): Promise<void> {
    const id = session.header.id;
    if (this.tracker.writerOf(id) !== undefined) return;
    await this.ready;
    const stored = await this.readLog(id, {});
    let handle: RdbSessionHandle;
    if (stored === undefined) {
      // 新会话：注册 pending 并返回 write handle；构造 seed 事件不发布
      // session/event，须在此一次性落库（与旧版 onCreated 同语义）。
      handle = (await this.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
      })) as RdbSessionHandle;
      const seed = session.snapshotEvents();
      if (seed.length > 0) await handle.append(seed);
    } else {
      // adopt：校验 cwd / inheritedEventCount / seed 前缀匹配后接管写所有权。
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
      // adopt 比较必须与读取视图同源：live seed 来自修复后的读取视图（补
      // stream、surface 修复），未修复的存储视图会把修复差异误判为 id 冲突。
      repairReadView(stored.events);
      const seed = session.snapshotEvents();
      if (!seedCoversPrefix(seed, stored.events)) {
        throw new Error(
          `session "${id}" already has a persisted log on disk that does not match this live session (id collision)`,
        );
      }
      handle = (await this.open(id, "write")) as RdbSessionHandle;
      // 持久化 seed 后缀（构造 seed 事件不发布 session/event，缓冲看不到）。
      const suffix = seed.slice(stored.events.length);
      if (suffix.length > 0) await handle.append(suffix);
    }
    // 把 handle 就绪前缓冲的事件移交。
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
  // node-postgres 要求 Pool 必须监听 error：未监听的 idle client error 会
  // 以 uncaughtException 崩溃进程；池级错误在下次查询处可见，这里只消费。
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
  // 两个批次一次性多行 INSERT（N 事件 2 条语句，而非 2N）。
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
      // fData 存完整事件（含 ignorable 信封，与 JSONL 每行同构）：data 部分
      // 与信封字段在同一 JSON 记录里，读回时整体解析。surfaceOp 走桥接行
      // 列（f_surface_op），sourceEventSeqs 不落库（读取时重计算）。
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
  return { headEventId: parentId, headSequence: nextSeq - 1 };
}

export default SessionPersistenceRdb;
