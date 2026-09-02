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
  type SessionEvent,
  type SurfaceEventType,
  type SessionId,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { type Backend, type BackendTx, type EventInsert, type EventRow } from "./backend.ts";
import { WriteGuard } from "./write-guard.ts";
import {
  buildSeqMap,
  recomputeReplaceProvenance,
  repairSurfaceOps,
  rowToMeta,
  scanRows,
  toJsonlArtifact,
} from "./log.ts";
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

  static readonly settingsNs = "session-rdb";

  override readonly name = "session-rdb";

  override readonly supportsRawArtifacts = true;

  override async readRaw(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").SessionRawArtifact | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const log = await this.readLog(id, {}, signal);
    if (log === undefined) return undefined;
    repairSurfaceOps(log.events);
    recomputeReplaceProvenance(log.events);
    const inheritedEventCount = Math.min(log.inheritedEventCount, log.events.length);
    return {
      meta: log.meta,
      inheritedEventCount: SessionLogOffset(inheritedEventCount),
      filename: "session.jsonl",
      content: toJsonlArtifact(log.meta, inheritedEventCount, log.events),
    };
  }

  private readonly backend: Backend;
  private storeIdentity!: string;
  private readonly ready: Promise<void>;
  private readonly coordinator: PersistenceCoordinator<number>;

  private readonly writeGuard = new WriteGuard();

  private readonly reuseEventIds = new Map<SessionId, Map<number, string>>();

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
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this);
    // 分支 provider 服务（rewind / forkFrom / timeline），随 fiber 卸载自动回滚。
    new SessionBranchRdb(this.ctx);
    // 导入端点：webServer + connection 就绪后注册 `/api/session.import`。
    registerSessionImport(this.ctx, this);
  }

  private async init(): Promise<void> {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }

  // --- SessionPersistence service surface (delegated to the coordinator) ---

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
    // 校验委托给 coordinator；这里只做品牌转换，避免 cordis proxy 下同步 throw 逃逸。
    return this.coordinator.readFrom(id, fromSeq as SessionLogOffset, signal);
  }

  override borrowSession(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<import("@deepseek-ai/dsh-session-persistence").BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal);
  }

  // --- PersistenceBackend hooks (the storage primitives) ---

  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    return this.readPrefix(id, signal);
  }

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

  private async readPrefix(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<number> | undefined> {
    const log = await this.readLog(id, {}, signal);
    if (log === undefined) {
      // 已确认缺席：本实例读过的新会话，后续对已出现行的 append 必须拒绝。
      this.writeGuard.confirmHead(id, -1);
      return undefined;
    }
    // 确认 head 是最后一个保留 seq（torn tail 由 commitRepair 删除并重确认）。
    this.writeGuard.confirmHead(id, log.events.at(-1)?.seq ?? -1);
    // replace 的 provenance 读取时重计算（sourceEventSeqs 不落库）。
    recomputeReplaceProvenance(log.events);
    return {
      meta: log.meta,
      inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
      events: log.events,
      // revision 表示必须与 readStoredRevision 的表示一致（见 listSnapshots）。
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${log.incarnation}:revision:${log.revision}`,
      ),
      ...(log.tornFrom !== undefined ? { tornMarker: log.tornFrom } : {}),
    };
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
    return SessionPersistenceRevision(
      `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`,
    );
  }

  private async readLog(
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
      // 全量读：seq map 由同一批行构建（无额外查询）。
      eventRows = await this.backend.getEventRows(id);
      seqMap = buildSeqMap(eventRows);
    } else {
      // 后缀读：坐标重映射需要每一行的上游 seq，另读轻量两列映射。
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
      // 重编号前拒绝第二个写入者：多实例共享数据库时，第二个写入者经陈旧
      // 视图 append 会把事件静默重编号到对方尾部、损坏 log。磁盘 head 必须
      // 等于本实例确认过的最后一个 head。
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
    // 提交后才确认新 head：回滚不得留下本实例实际未写的已确认 head。
    this.writeGuard.confirmHead(meta.id, confirmedHead);
  }

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
        // head 游标回退到最后一个幸存事件（torn tail 从 seq 0 开始时为初始态）。
        const prev = await tx.getPrevBridge(meta.id, tornMarker - 1);
        if (prev === undefined) {
          await tx.updateHead(meta.id, "", -1);
        } else {
          await tx.updateHead(meta.id, prev.fEventId, prev.fSequence);
        }
      }
      if (persistedClosers.length > 0) {
        // 锚定实际尾行：head 游标可能滞后于行（手工 torn tail 不更新游标）。
        const last = await tx.getLastBridge(meta.id);
        const { headEventId, headSequence } = await appendEventTail(tx, meta, persistedClosers, {
          parentId: last?.fEventId ?? "",
          nextSeq: (last?.fSequence ?? -1) + 1,
        });
        await tx.updateHead(meta.id, headEventId, headSequence);
      }
      await tx.bumpRevision(meta.id);
    });
    // 修复后重确认 head：截断会回退它、closers 会推进它，下一次 append 不得
    // 基于陈旧确认被拒绝（或更糟，被静默重编号）。
    const row = await this.backend.getSession(meta.id);
    this.writeGuard.confirmHead(meta.id, row?.fHeadSequence ?? -1);
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    return rows.map(rowToMeta);
  }

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
