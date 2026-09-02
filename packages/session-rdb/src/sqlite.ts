import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import {
  type Backend,
  type BackendTx,
  type EventInsert,
  type EventRow,
  type SessionRow,
} from "./backend.ts";
import { createTablesSql } from "./adapters/index.ts";
import { sqliteTableDefs } from "./entities/index.ts";
import { sessionConflictRow, sessionInsertRow } from "./log.ts";
import { migrateSqliteV1ToV2 } from "./migrate.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  tEvents,
  tPersistenceState,
  tSessionEvents,
  tSessions,
  type JournalMode,
} from "./schema.ts";

type SqliteDb = NodeSQLiteDatabase & { $client: DatabaseSync };

const sqliteTxQueues = new Map<string, Promise<void>>();

function enqueueSqliteTx<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = sqliteTxQueues.get(path) ?? Promise.resolve();
  const run = tail.then(fn);
  // 失败的事务不得毒化后续队列。
  sqliteTxQueues.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function openDatabase(
  path: string,
  journalMode: JournalMode,
  busyTimeout = DEFAULT_BUSY_TIMEOUT_MS,
): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    configureDatabase(db, path, journalMode, busyTimeout);
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

function configureDatabase(
  db: DatabaseSync,
  path: string,
  journalMode: JournalMode,
  busyTimeout: number,
): void {
  // 其余是驱动级 SQLite 操作（无 drizzle API）：连接 pragma 与 sqlite_schema 探测。
  db.exec("PRAGMA foreign_keys = ON");
  // busy_timeout 必须先于一切锁获取（初始化事务与每次写事务）。
  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  const dbx = drizzle({ client: db });
  // 初始化在单个 `BEGIN IMMEDIATE` 事务内完成，持写锁校验 schema 归属。
  dbx.transaction(
    (tx) => {
      const { user_version: onDisk } = tx.get(sql`PRAGMA user_version`) as {
        user_version: number;
      };
      const { application_id: applicationId } = tx.get(sql`PRAGMA application_id`) as {
        application_id: number;
      };
      const { count: userObjectCount } = tx.get(
        sql`SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'`,
      ) as { count: number };
      if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) {
        throw new Error(
          `session database at "${path}" has an unversioned schema or application identity`,
        );
      }
      if (onDisk === 1) {
        // 启动时自动迁移 v1 → v2（同一写锁事务内，失败整体回滚）。
        migrateSqliteV1ToV2(db);
      } else if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {
        throw new Error(
          `session database at "${path}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`,
        );
      }
      if (
        (onDisk === SCHEMA_VERSION || onDisk === 1) &&
        applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID
      ) {
        throw new Error(
          `session database at "${path}" has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`,
        );
      }
      for (const statement of createTablesSql("sqlite", sqliteTableDefs)) {
        tx.run(sql.raw(statement));
      }
      tx.insert(tPersistenceState)
        .values({ fSingleton: 1, fStoreId: randomUUID() })
        .onConflictDoNothing()
        .run();
      if (onDisk === 0) {
        tx.run(sql.raw(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`));
        tx.run(sql.raw(`PRAGMA user_version = ${SCHEMA_VERSION}`));
      }
    },
    { behavior: "immediate" },
  );
  // journal_mode 不可绑定，经校验后的联合可直接插值；在归属校验与初始化
  // 提交之后应用。
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
}

export interface SqliteBackendOptions {
  path: string;
  journalMode: JournalMode;
  busyTimeout: number;
}

export class SqliteBackend implements Backend {
  readonly kind = "sqlite" as const;
  storeIdentity!: string;

  private dbPath = "";
  private db!: SqliteDb;

  constructor(private readonly options: SqliteBackendOptions) {}

  async open(): Promise<void> {
    const actual =
      this.options.path === ":memory:" ? this.options.path : resolve(this.options.path);
    this.dbPath = actual;
    if (actual !== ":memory:") {
      await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
      await createDatabaseFile(actual);
    }
    // openDatabase 内的初始化事务是同步 `BEGIN IMMEDIATE`，须排进同一
    // per-path 写队列——否则与进行中的写事务竞争会在持有锁的异步回调
    // 让步期间忙等，冻结事件循环（死锁直到 busy_timeout）。
    await enqueueSqliteTx(actual, async () => {
      this.db = drizzle({
        client: openDatabase(actual, this.options.journalMode, this.options.busyTimeout),
      });
    });
    try {
      const row = this.db
        .select({ fStoreId: tPersistenceState.fStoreId })
        .from(tPersistenceState)
        .where(eq(tPersistenceState.fSingleton, 1))
        .get() as { fStoreId: string } | undefined;
      /* v8 ignore next -- openDatabase inserts the singleton before returning. */
      if (row === undefined) {
        throw new Error(`session database at "${actual}" has no store identity`);
      }
      if (row.fStoreId.length === 0) {
        throw new Error(`session database at "${actual}" has no valid store identity`);
      }
      if (actual !== ":memory:") {
        const identity = statSync(actual, { bigint: true });
        this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${row.fStoreId}`;
      } else {
        this.storeIdentity = `memory:store:${row.fStoreId}`;
      }
    } catch (error: unknown) {
      this.db.$client.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    // open 可能未及赋值 db 就失败（队列内初始化抛错）；close 不得在
    // coordinator 的 dispose 之上再崩。
    if (this.db === undefined) return;
    this.db.$client.close();
  }

  async getSession(id: SessionId): Promise<SessionRow | undefined> {
    return this.db.select().from(tSessions).where(eq(tSessions.fSessionId, id)).get() as
      | SessionRow
      | undefined;
  }

  async getSeqMapRows(id: SessionId): Promise<Array<{ fSequence: number; fOriginalSeq: number }>> {
    return this.db
      .select({ fSequence: tSessionEvents.fSequence, fOriginalSeq: tSessionEvents.fOriginalSeq })
      .from(tSessionEvents)
      .where(eq(tSessionEvents.fSessionId, id))
      .all();
  }

  async getEventRows(id: SessionId, fromSequence?: number): Promise<EventRow[]> {
    const scoped =
      fromSequence === undefined
        ? this.eventRows().where(eq(tSessionEvents.fSessionId, id))
        : this.eventRows().where(
            and(eq(tSessionEvents.fSessionId, id), gte(tSessionEvents.fSequence, fromSequence)),
          );
    return scoped.orderBy(tSessionEvents.fSequence).all() as unknown as EventRow[];
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.db.select().from(tSessions).all() as SessionRow[];
  }

  async transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T> {
    // drizzle 的 SQLite 驱动只支持同步事务回调，而共享 BackendTx 接口因
    // PostgreSQL 是异步的——BEGIN/COMMIT/ROLLBACK 语句因此走驱动层。
    // 异步回调在持写锁期间让出微任务间隙：本进程内第二个连接此时同步
    // `BEGIN IMMEDIATE` 会忙等并冻结事件循环（锁持有者无法提交，死锁直到
    // busy_timeout）。per-path 写队列串行化消除该间隙——SQLite 本就单写者；
    // 跨进程竞争仍经 busy_timeout 解决，不同数据库文件互不串行。
    return enqueueSqliteTx(this.dbPath, async () => {
      this.db.$client.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.tx);
        this.db.$client.exec("COMMIT");
        return result;
      } catch (error: unknown) {
        // DELETE+INSERT 不会冲突；这里回滚 DB 级失败（磁盘满等），测试不可达。
        /* v8 ignore start */
        try {
          this.db.$client.exec("ROLLBACK");
        } catch {
          // 原始 SQLite 失败仍是可操作的根因。
        }
        throw error;
        /* v8 ignore stop */
      }
    });
  }

  private readonly tx: BackendTx = {
    upsertSession: (storage, incarnation) => this.upsertSession(storage, incarnation),
    getHead: (id) => this.getHead(id),
    getSeedLength: (id) => this.getSeedLength(id),
    updateSeedLength: (id, seedLength) => this.updateSeedLength(id, seedLength),
    insertEvents: (events) => this.insertEvents(events),
    insertBridges: (rows) => this.insertBridges(rows),
    updateHead: (id, headEventId, headSequence) => this.updateHead(id, headEventId, headSequence),
    bumpRevision: (id) => this.bumpRevision(id),
    deleteBridgeTail: (id, fromSequence) => this.deleteBridgeTail(id, fromSequence),
    getPrevBridge: (id, sequence) => this.getPrevBridge(id, sequence),
    getLastBridge: (id) => this.getLastBridge(id),
  };

  // --- row primitives (transaction-internal or standalone) ---

  private async upsertSession(storage: SessionStorageMetadata, incarnation: string): Promise<void> {
    this.db
      .insert(tSessions)
      .values(sessionInsertRow(storage, incarnation))
      .onConflictDoUpdate({
        target: tSessions.fSessionId,
        set: sessionConflictRow(storage),
      })
      .run();
  }

  private async getHead(
    id: SessionId,
  ): Promise<Pick<SessionRow, "fHeadEventId" | "fHeadSequence">> {
    const head = this.db
      .select({ fHeadEventId: tSessions.fHeadEventId, fHeadSequence: tSessions.fHeadSequence })
      .from(tSessions)
      .where(eq(tSessions.fSessionId, id))
      .get() as Pick<SessionRow, "fHeadEventId" | "fHeadSequence"> | undefined;
    /* v8 ignore next -- appendBatch/commitRepair always materialize the row before reading the head */
    if (head === undefined) throw new Error(`session "${id}" has no materialized row`);
    return head;
  }

  private async getSeedLength(id: SessionId): Promise<number | null> {
    const row = this.db
      .select({ fSeedLength: tSessions.fSeedLength })
      .from(tSessions)
      .where(eq(tSessions.fSessionId, id))
      .get() as { fSeedLength: number | null } | undefined;
    /* v8 ignore next -- rewind always materializes the row before reading the seed length */
    if (row === undefined) throw new Error(`session "${id}" has no materialized row`);
    return row.fSeedLength;
  }

  private async updateSeedLength(id: SessionId, seedLength: number): Promise<void> {
    this.db
      .update(tSessions)
      .set({ fSeedLength: seedLength })
      .where(eq(tSessions.fSessionId, id))
      .run();
  }

  private static readonly INSERT_BATCH_ROWS = 1000;

  private async insertEvents(events: EventInsert[]): Promise<void> {
    if (events.length === 0) return;
    for (let i = 0; i < events.length; i += SqliteBackend.INSERT_BATCH_ROWS) {
      this.db
        .insert(tEvents)
        .values(events.slice(i, i + SqliteBackend.INSERT_BATCH_ROWS).map((event) => ({ ...event })))
        .run();
    }
  }

  private async insertBridges(
    rows: Array<{
      fSessionId: SessionId;
      fEventId: string;
      fSequence: number;
      fOriginalSeq: number;
      fSurfaceOp: string | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += SqliteBackend.INSERT_BATCH_ROWS) {
      this.db
        .insert(tSessionEvents)
        .values(rows.slice(i, i + SqliteBackend.INSERT_BATCH_ROWS).map((row) => ({ ...row })))
        .run();
    }
  }

  private async updateHead(
    id: SessionId,
    headEventId: string,
    headSequence: number,
  ): Promise<void> {
    this.db
      .update(tSessions)
      .set({ fHeadEventId: headEventId, fHeadSequence: headSequence })
      .where(eq(tSessions.fSessionId, id))
      .run();
  }

  private async bumpRevision(id: SessionId): Promise<void> {
    this.db
      .update(tSessions)
      .set({ fRevision: sql`${tSessions.fRevision} + 1` })
      .where(eq(tSessions.fSessionId, id))
      .run();
  }

  private async deleteBridgeTail(id: SessionId, fromSequence: number): Promise<void> {
    this.db
      .delete(tSessionEvents)
      .where(and(eq(tSessionEvents.fSessionId, id), gte(tSessionEvents.fSequence, fromSequence)))
      .run();
  }

  private async getPrevBridge(
    id: SessionId,
    sequence: number,
  ): Promise<{ fEventId: string; fSequence: number } | undefined> {
    return this.db
      .select({ fEventId: tSessionEvents.fEventId, fSequence: tSessionEvents.fSequence })
      .from(tSessionEvents)
      .where(and(eq(tSessionEvents.fSessionId, id), eq(tSessionEvents.fSequence, sequence)))
      .get() as { fEventId: string; fSequence: number } | undefined;
  }

  private async getLastBridge(
    id: SessionId,
  ): Promise<{ fEventId: string; fSequence: number } | undefined> {
    return this.db
      .select({ fEventId: tSessionEvents.fEventId, fSequence: tSessionEvents.fSequence })
      .from(tSessionEvents)
      .where(eq(tSessionEvents.fSessionId, id))
      .orderBy(desc(tSessionEvents.fSequence))
      .limit(1)
      .get() as { fEventId: string; fSequence: number } | undefined;
  }

  private eventRows() {
    return this.db
      .select({
        fEventId: tSessionEvents.fEventId,
        fSequence: tSessionEvents.fSequence,
        fOriginalSeq: tSessionEvents.fOriginalSeq,
        fType: tEvents.fType,
        fKind: tEvents.fKind,
        fRole: tEvents.fRole,
        fName: tEvents.fName,
        fActionId: tEvents.fActionId,
        fCreatedAt: tEvents.fCreatedAt,
        fData: tEvents.fData,
        fSurfaceOp: tSessionEvents.fSurfaceOp,
      })
      .from(tSessionEvents)
      .innerJoin(tEvents, eq(tSessionEvents.fEventId, tEvents.fEventId));
  }
}
