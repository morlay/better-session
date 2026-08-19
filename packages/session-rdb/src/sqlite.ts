/**
 * SQLite 存储后端：在 `node:sqlite` `DatabaseSync` 之上实现 {@link Backend}。
 * drizzle 经 `drizzle-orm/node-sqlite` 驱动包装，查询语义与 PostgreSQL 后端
 * 共用同一套 {@link BackendTx} 原语。数据库打开/建表/schema 版本与身份校验
 * （{@link openDatabase}）也归本模块所有——`SqliteBackend` 的实现不跨文件。
 *
 * 事务：SQLite 单连接，`BEGIN IMMEDIATE` 提前获取写锁（受 `busy_timeout`
 * pragma 排队保护）；`COMMIT`/`ROLLBACK` 之后同一连接继续服务普通查询。
 * @module @morlay/session-rdb/sqlite
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import type { SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
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

/** The drizzle handle over the open `node:sqlite` database, plus its raw client. */
type SqliteDb = NodeSQLiteDatabase & { $client: DatabaseSync };

/**
 * Process-wide SQLite write-transaction queues, keyed by database path.
 * SQLite allows exactly one writer, and the async transaction callback (see
 * {@link SqliteBackend.transaction}) must never overlap another connection's
 * `BEGIN IMMEDIATE` inside this process: the second, synchronous BEGIN would
 * busy-wait on the lock and freeze the event loop, so the lock holder could
 * never commit (deadlock until busy_timeout). Serializing per PATH removes the
 * gap entirely.
 *
 * The queue is per path, not global: two backends on DIFFERENT files have no
 * lock to contend for, so serializing them would be pure waste. Two instances
 * sharing one file (the supported multi-process deployment) still share one
 * queue, preserving the deadlock guarantee. `:memory:` databases are distinct
 * per connection but share the key — serializing them is harmless (tests).
 */
const sqliteTxQueues = new Map<string, Promise<void>>();

/** Run `fn` behind the write-transaction queue for one database path. */
function enqueueSqliteTx<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = sqliteTxQueues.get(path) ?? Promise.resolve();
  const run = tail.then(fn);
  // A failed transaction must not poison the queue for later ones.
  sqliteTxQueues.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * `DatabaseSync` reopens by path, so this does not protect confidentiality or
 * integrity when another principal can replace the database entry in its parent
 * directory.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Open the database and apply its schema and pragmas. An empty database with a
 * zero `user_version` is initialized at {@link SCHEMA_VERSION}; a nonempty
 * unversioned database and every other non-current version reject rather than
 * being migrated in place.
 * @param path - the SQLite database file to open (created when absent).
 * @param journalMode - validated journal pragma.
 * @param busyTimeout - milliseconds to wait for a contended write lock before
 *   failing with `SQLITE_BUSY`; `0` fails immediately (SQLite's default).
 * @returns the open handle with pragmas applied and all tables ensured.
 */
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
  // The remaining raw statements are driver-level SQLite operations with no
  // drizzle API: connection pragmas (foreign_keys / busy_timeout / journal_mode
  // / user_version / application_id) and the sqlite_schema system-table probe.
  db.exec("PRAGMA foreign_keys = ON");
  // The busy timeout must precede every lock acquisition (the initialization
  // transaction below, and each write transaction in the backend) so a
  // contended database queues instead of failing one process's writes outright.
  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  const dbx = drizzle({ client: db });
  // Initialization runs in ONE drizzle transaction (`BEGIN IMMEDIATE` acquires
  // the write lock up front). Validate while holding the write lock so no other
  // connection can change schema ownership between inspection and init.
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
      if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {
        throw new Error(
          `session database at "${path}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`,
        );
      }
      if (
        onDisk === SCHEMA_VERSION &&
        applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID
      ) {
        throw new Error(
          `session database at "${path}" has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`,
        );
      }
      for (const statement of createTablesSql("sqlite", sqliteTableDefs)) {
        tx.run(sql.raw(statement));
      }
      // The store identity row comes from the same drizzle table object; the
      // OR-IGNORE semantics are drizzle's `onConflictDoNothing` (the singleton
      // row already exists after the first open).
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
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  // Apply it only after ownership validation and initialization commit.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
}

/** SQLite 后端的打开参数（来自配置的 sqlite 分支）。 */
export interface SqliteBackendOptions {
  path: string;
  journalMode: JournalMode;
  busyTimeout: number;
}

/**
 * SQLite 存储后端。打开时创建目录/文件（owner-only）、应用 pragma 与 DDL、
 * 校验 schema 版本/应用身份并读取 store id。
 */
export class SqliteBackend implements Backend {
  readonly kind = "sqlite" as const;
  storeIdentity!: string;

  /** The resolved database path (queue key); set by {@link open}. */
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
    // The initialization transaction inside openDatabase is a synchronous
    // `BEGIN IMMEDIATE`, so it must queue behind the same per-path write queue
    // as the backend's own transactions: if another instance (sharing the
    // file) is mid-transaction and its async callback is yielding, a
    // synchronous BEGIN here would busy-wait and freeze the event loop until
    // busy_timeout — the other instance could never commit. Queuing turns that
    // "open collides with an in-flight write" race into a queue wait.
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
    // `open` may have failed before assigning `db` (e.g. the queued init threw);
    // close must not crash the coordinator's dispose on top of that failure.
    if (this.db === undefined) return;
    this.db.$client.close();
  }

  async getSession(id: SessionId): Promise<SessionRow | undefined> {
    return this.db.select().from(tSessions).where(eq(tSessions.fSessionId, id)).get() as
      | SessionRow
      | undefined;
  }

  async getSeqMapRows(id: SessionId): Promise<Array<{ fSequence: number; fOriginalSeq: number; fKind: string }>> {
    return this.eventRows().where(eq(tSessionEvents.fSessionId, id)).all();
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
    // drizzle's SQLite driver only supports SYNCHRONOUS transaction callbacks
    // (an async callback is rejected at the type level), while the shared
    // `BackendTx` interface is async because PostgreSQL is. The BEGIN/COMMIT/
    // ROLLBACK statements below are therefore driver-level and unavoidable.
    //
    // The async transaction callback also yields microtask gaps while the write
    // lock is held. A second connection in THIS process (another backend
    // instance sharing the file) that synchronously executes `BEGIN IMMEDIATE`
    // during such a gap would busy-wait on the lock and block the event loop,
    // so the lock holder could never commit (deadlock until busy_timeout).
    // Serializing the per-path write queue (see {@link enqueueSqliteTx})
    // removes the gap entirely — SQLite has one writer anyway, and a separate
    // process has its own event loop, so cross-process contention still
    // resolves through busy_timeout. A backend on a DIFFERENT database file has
    // no lock to contend for and is not serialized with this one.
    return enqueueSqliteTx(this.dbPath, async () => {
      this.db.$client.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.tx);
        this.db.$client.exec("COMMIT");
        return result;
      } catch (error: unknown) {
        // The DELETE+INSERT cannot collide; this rolls back a DB-level failure
        // (disk full, etc.), unreachable in test.
        /* v8 ignore start */
        try {
          this.db.$client.exec("ROLLBACK");
        } catch {
          // The original SQLite failure remains the actionable cause.
        }
        throw error;
        /* v8 ignore stop */
      }
    });
  }

  /**
   * SQLite is a single connection: after `BEGIN IMMEDIATE` every query on the
   * same handle is inside the transaction, so the tx primitives are the same
   * row primitives used by the non-transactional reads.
   */
  private readonly tx: BackendTx = {
    upsertSession: (meta, incarnation) => this.upsertSession(meta, incarnation),
    getHead: (id) => this.getHead(id),
    insertEvents: (events) => this.insertEvents(events),
    insertBridges: (rows) => this.insertBridges(rows),
    updateHead: (id, headEventId, headSequence) => this.updateHead(id, headEventId, headSequence),
    bumpRevision: (id) => this.bumpRevision(id),
    deleteBridgeTail: (id, fromSequence) => this.deleteBridgeTail(id, fromSequence),
    getPrevBridge: (id, sequence) => this.getPrevBridge(id, sequence),
    getLastBridge: (id) => this.getLastBridge(id),
  };

  // --- row primitives (transaction-internal or standalone) ---

  private async upsertSession(meta: SessionHeader, incarnation: string): Promise<void> {
    this.db
      .insert(tSessions)
      .values(sessionInsertRow(meta, incarnation))
      .onConflictDoUpdate({
        target: tSessions.fSessionId,
        set: sessionConflictRow(meta),
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

  private async insertEvents(events: EventInsert[]): Promise<void> {
    if (events.length === 0) return;
    this.db
      .insert(tEvents)
      .values(events.map((event) => ({ ...event })))
      .run();
  }

  private async insertBridges(
    rows: Array<{ fSessionId: SessionId; fEventId: string; fSequence: number }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    this.db
      .insert(tSessionEvents)
      .values(rows.map((row) => ({ ...row })))
      .run();
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

  /** The joined event-row projection shared by whole-log and suffix reads. */
  private eventRows() {
    return this.db
      .select({
        fSequence: tSessionEvents.fSequence,
        fOriginalSeq: tEvents.fOriginalSeq,
        fKind: tEvents.fKind,
        fCreatedAt: tEvents.fCreatedAt,
        fData: tEvents.fData,
        fSourceEventSeqs: tEvents.fSourceEventSeqs,
        fSurfaceOp: tEvents.fSurfaceOp,
      })
      .from(tSessionEvents)
      .innerJoin(tEvents, eq(tSessionEvents.fEventId, tEvents.fEventId));
  }
}
