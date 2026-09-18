import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { and, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import {
  type Backend,
  type BackendTx,
  type EventInsert,
  type EventRow,
  type SessionRow,
} from "./backend.ts";
import { sessionConflictRow, sessionInsertRow, titleOfEventData, usageRowOf } from "./log.ts";
import type { UsageAggregate, UsageTotals } from "./usage.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  tEventUsage,
  tEvents,
  tPersistenceState,
  tSessionEvents,
  tSessionProjcacheRows,
  tSessions,
  tStorageUnits,
  tWorkspaceSessions,
  tWorkspaceState,
  tWorkspaces,
  type JournalMode,
} from "./schema.ts";
import { createStorageRepository } from "./storage-takeover/repository.ts";
import type { StorageRepository } from "./storage-takeover/types.ts";

type SqliteDb = NodeSQLiteDatabase & { $client: DatabaseSync };

/** 用量聚合的原始行（列名是 SQL 别名）。 */
interface RawUsageRow {
  day: string;
  provider: string | null;
  model: string | null;
  subagent: number;
  events: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
}

/**
 * 一次性回填：旧库的用量从未写过 `t_event_usage`，建表后按事件行补一次（幂等：表非空即跳过）。
 */
function backfillEventUsage(db: DatabaseSync): void {
  const pending = db.prepare("SELECT count(*) AS n FROM t_event_usage").get() as { n: number };
  if (pending.n > 0) return;
  db.exec(`INSERT OR IGNORE INTO t_event_usage (
      f_event_id, f_created_at, f_provider, f_model,
      f_input_tokens, f_output_tokens, f_cache_read_tokens, f_reasoning_tokens, f_total_tokens)
    SELECT e.f_event_id, e.f_created_at,
           coalesce(json_extract(e.f_data, '$.data.message.source.provider'),
                    json_extract(e.f_data, '$.message.source.provider')),
           coalesce(json_extract(e.f_data, '$.data.message.source.model'),
                    json_extract(e.f_data, '$.message.source.model')),
           coalesce(json_extract(e.f_data, '$.data.usage.inputTokens'),
                    json_extract(e.f_data, '$.usage.inputTokens'), 0),
           coalesce(json_extract(e.f_data, '$.data.usage.outputTokens'),
                    json_extract(e.f_data, '$.usage.outputTokens'), 0),
           coalesce(json_extract(e.f_data, '$.data.usage.cacheReadTokens'),
                    json_extract(e.f_data, '$.usage.cacheReadTokens'), 0),
           coalesce(json_extract(e.f_data, '$.data.usage.reasoningTokens'),
                    json_extract(e.f_data, '$.usage.reasoningTokens'), 0),
           coalesce(json_extract(e.f_data, '$.data.usage.totalTokens'),
                    json_extract(e.f_data, '$.usage.totalTokens'), 0)
      FROM t_events e
     WHERE e.f_type = 'assistant/message'
       AND (json_extract(e.f_data, '$.data.usage') IS NOT NULL
            OR json_extract(e.f_data, '$.usage') IS NOT NULL)`);
}

/** SQL 的缺失求和是 NULL：没有 usage 字段的行使该字段计 0。 */
function totalsOf(row: RawUsageRow): UsageTotals {
  return {
    events: row.events,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
  };
}

const sqliteMigrationsDir = fileURLToPath(new URL("../drizzle/sqlite/", import.meta.url));

const sqliteTxQueues = new Map<string, Promise<void>>();

function enqueueSqliteTx<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = sqliteTxQueues.get(path) ?? Promise.resolve();
  const run = tail.then(fn);

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

export async function openDatabase(
  path: string,
  journalMode: JournalMode,
  busyTimeout = DEFAULT_BUSY_TIMEOUT_MS,
): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  try {
    configureDatabase(db, path, journalMode, busyTimeout);
    const dbx = drizzle({ client: db });
    const { user_version: onDisk } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (onDisk === 2 && !hasMigrationsTable(db)) {
      await baselineV2(db);
    }
    migrate(dbx, { migrationsFolder: sqliteMigrationsDir });
    backfillEventUsage(db);

    dbx
      .insert(tPersistenceState)
      .values({ fSingleton: 1, fStoreId: randomUUID() })
      .onConflictDoNothing()
      .run();
    if (onDisk === 0 || onDisk === 2) {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }

    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

function hasMigrationsTable(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get() !== undefined
  );
}

async function baselineV2(db: DatabaseSync): Promise<void> {
  const dir = (await readdir(sqliteMigrationsDir)).find((name) => name.endsWith("_v2_initial"));
  if (dir === undefined) throw new Error("missing v2 baseline migration in drizzle/sqlite");
  db.exec(`
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )
  `);
  db.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
  ).run("baseline", 0, dir, new Date().toISOString());
}

function configureDatabase(
  db: DatabaseSync,
  path: string,
  journalMode: JournalMode,
  busyTimeout: number,
): void {
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  const dbx = drizzle({ client: db });

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
      if (onDisk !== 0 && onDisk !== 2 && onDisk !== SCHEMA_VERSION) {
        throw new Error(
          `session database at "${path}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`,
        );
      }
      if (onDisk >= 1 && applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
        throw new Error(
          `session database at "${path}" has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`,
        );
      }
      if (onDisk === 0) {
        tx.run(sql.raw(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`));
        tx.run(sql.raw(`PRAGMA user_version = ${SCHEMA_VERSION}`));
      }
    },
    { behavior: "immediate" },
  );
}

export interface SqliteBackendOptions {
  path: string;
  journalMode: JournalMode;
  busyTimeout: number;
}

export class SqliteBackend implements Backend {
  readonly kind = "sqlite" as const;
  storeIdentity!: string;

  readonly storage: StorageRepository;

  private dbPath = "";
  private db!: SqliteDb;
  private readonly dbReady: Promise<SqliteDb>;
  private resolveDb!: (db: SqliteDb) => void;
  private rejectDb!: (error: unknown) => void;

  constructor(private readonly options: SqliteBackendOptions) {
    this.dbReady = new Promise<SqliteDb>((resolve, reject) => {
      this.resolveDb = resolve;
      this.rejectDb = reject;
    });

    this.dbReady.catch(() => {});
    this.storage = createStorageRepository({
      db: () => this.dbReady,

      dbDirect: () => {
        if (this.db === undefined) throw new Error("sqlite session database is not open");
        return this.db;
      },
      writeAtomically: (fn) =>
        enqueueSqliteTx(this.dbPath, async () => {
          const db = await this.dbReady;
          db.$client.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn();
            db.$client.exec("COMMIT");
            return result;
          } catch (error: unknown) {
            try {
              db.$client.exec("ROLLBACK");
            } catch {}
            throw error;
          }
        }),
      tables: {
        t_sessions: tSessions,
        t_storage_units: tStorageUnits,
        t_workspaces: tWorkspaces,
        t_workspace_sessions: tWorkspaceSessions,
        t_workspace_state: tWorkspaceState,
        t_session_projcache_row: tSessionProjcacheRows,
      },
    });
  }

  async open(): Promise<void> {
    try {
      await this.doOpen();
      this.resolveDb(this.db);
    } catch (error: unknown) {
      this.rejectDb(error);
      throw error;
    }
  }

  private async doOpen(): Promise<void> {
    const actual =
      this.options.path === ":memory:" ? this.options.path : resolve(this.options.path);
    this.dbPath = actual;
    if (actual !== ":memory:") {
      await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
      await createDatabaseFile(actual);
    }

    await enqueueSqliteTx(actual, async () => {
      this.db = drizzle({
        client: await openDatabase(actual, this.options.journalMode, this.options.busyTimeout),
      });

      migrate(this.db, { migrationsFolder: sqliteMigrationsDir });
    });
    try {
      const row = this.db
        .select({ fStoreId: tPersistenceState.fStoreId })
        .from(tPersistenceState)
        .where(eq(tPersistenceState.fSingleton, 1))
        .get() as { fStoreId: string } | undefined;

      if (row === undefined) {
        throw new Error(`session database at "${actual}" has no store identity`);
      }
      if (row.fStoreId.length === 0) {
        throw new Error(`session database at "${actual}" has no valid store identity`);
      }
      if (actual !== ":memory:") {
        const identity = await stat(actual, { bigint: true });
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
    if (this.db === undefined) return;
    this.db.$client.close();
  }

  async getSession(id: SessionId): Promise<SessionRow | undefined> {
    return this.db.select().from(tSessions).where(eq(tSessions.fSessionId, id)).get() as
      | SessionRow
      | undefined;
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

  async getEventTypeAt(id: SessionId, sequence: number): Promise<string | undefined> {
    const row = this.eventRows()
      .where(and(eq(tSessionEvents.fSessionId, id), eq(tSessionEvents.fSequence, sequence)))
      .get() as { fType?: string } | undefined;
    return row?.fType;
  }

  async getEventTypesBefore(
    id: SessionId,
    beforeSequence: number,
    limit: number,
  ): Promise<Array<Pick<EventRow, "fSequence" | "fType">>> {
    return this.eventRows()
      .where(and(eq(tSessionEvents.fSessionId, id), lt(tSessionEvents.fSequence, beforeSequence)))
      .orderBy(desc(tSessionEvents.fSequence))
      .limit(limit)
      .all() as unknown as Array<Pick<EventRow, "fSequence" | "fType">>;
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.db.select().from(tSessions).all() as SessionRow[];
  }

  async transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T> {
    return enqueueSqliteTx(this.dbPath, async () => {
      this.db.$client.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.tx);
        this.db.$client.exec("COMMIT");
        return result;
      } catch (error: unknown) {
        try {
          this.db.$client.exec("ROLLBACK");
        } catch {}
        throw error;
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
    refreshTitle: (id) => this.refreshTitle(id),
    deleteBridgeTail: (id, fromSequence) => this.deleteBridgeTail(id, fromSequence),
    getPrevBridge: (id, sequence) => this.getPrevBridge(id, sequence),
    deleteSession: (id) => this.deleteSession(id),
    deleteSessions: (ids) => this.deleteSessions(ids),
  };

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

    if (head === undefined) throw new Error(`session "${id}" has no materialized row`);
    return head;
  }

  private async getSeedLength(id: SessionId): Promise<number | null> {
    const row = this.db
      .select({ fSeedLength: tSessions.fSeedLength })
      .from(tSessions)
      .where(eq(tSessions.fSessionId, id))
      .get() as { fSeedLength: number | null } | undefined;

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
    // 用量顺带落 t_event_usage：统计不再逐行解析事件 JSON（重复事件行忽略，fork 复用不重复记）。
    const usage = events.flatMap((event) => {
      const row = usageRowOf(event);
      return row === undefined ? [] : [row];
    });
    if (usage.length > 0) {
      this.db.insert(tEventUsage).values(usage).onConflictDoNothing().run();
    }
  }

  private async insertBridges(
    rows: Array<{
      fSessionId: SessionId;
      fEventId: string;
      fSequence: number;
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

  private async refreshTitle(id: SessionId): Promise<void> {
    const row = this.db
      .select({ fSequence: tSessionEvents.fSequence, fData: tEvents.fData })
      .from(tSessionEvents)
      .innerJoin(tEvents, eq(tEvents.fEventId, tSessionEvents.fEventId))
      .where(and(eq(tSessionEvents.fSessionId, id), eq(tEvents.fType, "session/title")))
      .orderBy(desc(tSessionEvents.fSequence))
      .limit(1)
      .get() as { fSequence: number; fData: string } | undefined;
    const title = row === undefined ? undefined : titleOfEventData(row.fData);
    this.db
      .update(tSessions)
      .set({ fTitle: title ?? null, fTitleSeq: title === undefined ? null : row!.fSequence })
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

  private async deleteSession(id: SessionId): Promise<void> {
    this.db.delete(tSessionEvents).where(eq(tSessionEvents.fSessionId, id)).run();
    this.db.delete(tWorkspaceSessions).where(eq(tWorkspaceSessions.fSessionId, id)).run();
    this.db.delete(tSessionProjcacheRows).where(eq(tSessionProjcacheRows.fSessionId, id)).run();
    this.db.delete(tSessions).where(eq(tSessions.fSessionId, id)).run();
  }

  /** 事件行可能被多个会话共享（fork 派生），所以孤儿只能在全库范围内判定。 */
  async collectOrphans(): Promise<number> {
    const referenced = this.db.select({ fEventId: tSessionEvents.fEventId }).from(tSessionEvents);
    const info = this.db.delete(tEvents).where(notInArray(tEvents.fEventId, referenced)).run();
    // 用量行跟着事件行走：没有事件行的用量不再计入统计。
    this.db
      .delete(tEventUsage)
      .where(
        notInArray(
          tEventUsage.fEventId,
          this.db.select({ fEventId: tEvents.fEventId }).from(tEvents),
        ),
      )
      .run();
    return Number(info.changes);
  }

  /** 父会话被删后留下的 subagent 会话：父已不在表里，或本来就没有父。 */
  async listOrphanSubagentSessions(): Promise<SessionId[]> {
    const rows = this.db.$client
      .prepare(
        `SELECT f_session_id AS id FROM t_sessions
         WHERE f_origin = 'subagent'
           AND (f_parent_session IS NULL
                OR f_parent_session NOT IN (SELECT f_session_id FROM t_sessions))`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id as SessionId);
  }

  private async deleteSessions(ids: SessionId[]): Promise<number> {
    if (ids.length === 0) return 0;
    this.db.delete(tSessionEvents).where(inArray(tSessionEvents.fSessionId, ids)).run();
    this.db.delete(tWorkspaceSessions).where(inArray(tWorkspaceSessions.fSessionId, ids)).run();
    this.db
      .delete(tSessionProjcacheRows)
      .where(inArray(tSessionProjcacheRows.fSessionId, ids))
      .run();
    const info = this.db.delete(tSessions).where(inArray(tSessions.fSessionId, ids)).run();
    return Number(info.changes);
  }

  /** 用量聚合：只读 `t_event_usage`；可选只算 `sinceMs` 之后的事件行。 */
  async usageReport(sinceMs?: number): Promise<UsageAggregate> {
    const sinceClause = sinceMs === undefined ? "" : " AND u.f_created_at >= ?";
    const sinceParams = sinceMs === undefined ? [] : [sinceMs];
    const buckets = this.db.$client
      .prepare(
        `SELECT date(u.f_created_at / 1000, 'unixepoch', 'localtime') AS day,
                u.f_provider AS provider,
                u.f_model AS model,
                EXISTS (SELECT 1 FROM t_session_events sb
                          JOIN t_sessions ss ON ss.f_session_id = sb.f_session_id
                         WHERE sb.f_event_id = u.f_event_id AND ss.f_origin = 'subagent') AS subagent,
                count(*) AS events,
                sum(u.f_input_tokens) AS input_tokens,
                sum(u.f_output_tokens) AS output_tokens,
                sum(u.f_cache_read_tokens) AS cache_read_tokens,
                sum(u.f_reasoning_tokens) AS reasoning_tokens,
                sum(u.f_total_tokens) AS total_tokens
           FROM t_event_usage u
          WHERE EXISTS (SELECT 1 FROM t_session_events rb WHERE rb.f_event_id = u.f_event_id)${sinceClause}
          GROUP BY day, provider, model, subagent`,
      )
      .all(...sinceParams) as unknown as RawUsageRow[];
    const sessions = this.db.$client
      .prepare(
        `SELECT b.f_session_id AS session_id,
                s.f_title AS title,
                (s.f_origin = 'subagent') AS subagent,
                (s.f_archived_at IS NOT NULL) AS archived,
                count(*) AS events,
                sum(u.f_input_tokens) AS input_tokens,
                sum(u.f_output_tokens) AS output_tokens,
                sum(u.f_cache_read_tokens) AS cache_read_tokens,
                sum(u.f_reasoning_tokens) AS reasoning_tokens,
                sum(u.f_total_tokens) AS total_tokens
           FROM t_session_events b
           JOIN t_event_usage u ON u.f_event_id = b.f_event_id
           JOIN t_sessions s ON s.f_session_id = b.f_session_id
          WHERE 1 = 1${sinceClause}
          GROUP BY b.f_session_id, s.f_title, s.f_origin, s.f_archived_at`,
      )
      .all(...sinceParams) as unknown as Array<
      RawUsageRow & { session_id: string; title: string | null; archived: number }
    >;
    return {
      buckets: buckets.map((row) => ({
        day: row.day,
        provider: row.provider,
        model: row.model,
        subagent: row.subagent === 1,
        ...totalsOf(row),
      })),
      sessions: sessions.map((row) => ({
        sessionId: row.session_id,
        title: row.title,
        subagent: row.subagent === 1,
        archived: row.archived === 1,
        ...totalsOf(row),
      })),
    };
  }

  async vacuum(): Promise<void> {
    await enqueueSqliteTx(this.dbPath, async () => {
      this.db.$client.exec("VACUUM");
    });
  }

  private eventRows() {
    return this.db
      .select({
        fEventId: tSessionEvents.fEventId,
        fSequence: tSessionEvents.fSequence,
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
