/**
 * PostgreSQL 存储后端：在 drizzle 的 PG async 驱动之上实现 {@link Backend}。
 * 驱动（`drizzle-orm/node-postgres` 生产 / `drizzle-orm/pglite` 测试）在构造
 * 时注入，因此本模块不依赖具体 PG 客户端包。
 *
 * 与 SQLite 的差异（方言事实，非行为差异）：
 * - `f_created_at` 用 `BIGINT`（毫秒时间戳超出 PG `INTEGER` 的 int32 范围）；
 * - schema 版本/应用身份校验用 `t_schema_meta` 键值表代替 SQLite 的
 *   `PRAGMA user_version` / `application_id`（PG 无等价 pragma）；
 * - 事务用 drizzle 的异步 `db.transaction`（PG 无 `BEGIN IMMEDIATE`，写锁靠
 *   `busy_timeout` 之外的数据库行锁/唯一约束兜底）。
 * @module @morlay/session-rdb/postgres
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgAsyncTransaction, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import {
  type Backend,
  type BackendTx,
  type EventInsert,
  type EventRow,
  type SessionRow,
} from "./backend.ts";
import { SCHEMA_VERSION, SESSION_PERSISTENCE_SQLITE_APPLICATION_ID } from "./schema.ts";
import { createTablesSql, toPostgresSchema } from "./adapters/index.ts";
import { postgresTableDefs } from "./entities/index.ts";
import { sessionConflictRow, sessionInsertRow } from "./log.ts";

/** PostgreSQL 后端的打开参数。 */
export interface PostgresBackendOptions {
  /** Revision 源限定前缀（不含 store id），如 `postgres:host:port:database`。 */
  identityBase: string;
  /** PostgreSQL schema 持有会话表（默认 `public`）。 */
  schema?: string;
  /** 关闭底层连接（生产 `pool.end()`；测试 `pglite.close()`）。 */
  close: () => Promise<void>;
}

/**
 * PostgreSQL 存储后端。构造时注入 drizzle PG 实例；{@link open} 建表并做
 * schema 版本/应用身份校验（`t_schema_meta`，替代 SQLite 的 PRAGMA）。
 * 表对象按配置的 schema 构建（`pgSchema(name).table`，显式限定，不依赖
 * search_path）。
 */
export class PostgresBackend<THKT extends PgQueryResultHKT = PgQueryResultHKT> implements Backend {
  readonly kind = "postgres" as const;
  storeIdentity!: string;

  /** 按配置 schema 构建的 drizzle 表对象（默认 public）。 */
  private readonly tables: Record<string, any>;

  constructor(
    private readonly db: PgAsyncDatabase<THKT>,
    private readonly options: PostgresBackendOptions,
  ) {
    this.tables = toPostgresSchema(postgresTableDefs, this.options.schema ?? "public");
  }

  async open(): Promise<void> {
    const storeId = await this.db.transaction(async (tx) => {
      const schema = this.options.schema ?? "public";
      // 探测必须在建表之前：t_schema_meta 存在与否区分「全新库」与「已有库」。
      // `to_regclass` 是数据库元数据查询，drizzle 没有对应 API。schema 限定
      // 显式引用（不依赖 search_path）。
      const qualifiedMeta = schema === "public" ? "t_schema_meta" : `"${schema}".t_schema_meta`;
      const probe = (await tx.execute(
        sql`SELECT to_regclass(${qualifiedMeta}) IS NOT NULL AS exists`,
      )) as unknown as { rows: { exists: boolean }[] };
      const metaExists = probe.rows[0]?.exists === true;
      // DDL 由实体描述生成（一次一条：PG 的 extended query protocol 拒绝
      // 多语句字符串，且 DDL 事务性，逐条执行保持初始化原子）。
      for (const statement of createTablesSql("postgres", postgresTableDefs, schema)) {
        await tx.execute(sql.raw(statement));
      }
      if (!metaExists) {
        await tx
          .insert(this.tables["t_schema_meta"])
          .values([
            { fKey: "schema_version", fValue: String(SCHEMA_VERSION) },
            { fKey: "application_id", fValue: String(SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) },
          ])
          .execute();
      }
      // 校验（缺版本行 = 有对象但未版本化 → 拒绝，不迁移）。
      const version = await this.readMeta(tx, "schema_version");
      const applicationId = await this.readMeta(tx, "application_id");
      if (version === undefined || applicationId === undefined) {
        throw new Error("session database has an unversioned schema or application identity");
      }
      if (Number(version) !== SCHEMA_VERSION) {
        throw new Error(
          `session database has schema version ${version}, incompatible with this build (${SCHEMA_VERSION})`,
        );
      }
      if (Number(applicationId) !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
        throw new Error(
          `session database has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`,
        );
      }
      await tx
        .insert(this.tables["t_persistence_state"])
        .values({ fSingleton: 1, fStoreId: randomUUID() })
        .onConflictDoNothing()
        .execute();
      const store = await tx
        .select({ fStoreId: this.tables["t_persistence_state"].fStoreId })
        .from(this.tables["t_persistence_state"])
        .where(eq(this.tables["t_persistence_state"].fSingleton, 1))
        .execute();
      const storeId = store[0]?.fStoreId;
      if (storeId === undefined || storeId.length === 0) {
        throw new Error("session database has no valid store identity");
      }
      return storeId;
    });
    this.storeIdentity = `${this.options.identityBase}:store:${storeId}`;
  }

  async close(): Promise<void> {
    await this.options.close();
  }

  async getSession(id: SessionId): Promise<SessionRow | undefined> {
    return (
      await this.db.select().from(this.tables["t_sessions"]).where(eq(this.tables["t_sessions"].fSessionId, id)).execute()
    )[0] as SessionRow | undefined;
  }

  async getSeqMapRows(
    id: SessionId,
  ): Promise<Array<{ fSequence: number; fOriginalSeq: number }>> {
    return this.db
      .select({ fSequence: this.tables["t_session_events"].fSequence, fOriginalSeq: this.tables["t_session_events"].fOriginalSeq })
      .from(this.tables["t_session_events"])
      .where(eq(this.tables["t_session_events"].fSessionId, id))
      .execute();
  }

  async getEventRows(id: SessionId, fromSequence?: number): Promise<EventRow[]> {
    const scoped =
      fromSequence === undefined
        ? this.eventRows(this.db).where(eq(this.tables["t_session_events"].fSessionId, id))
        : this.eventRows(this.db).where(
            and(eq(this.tables["t_session_events"].fSessionId, id), gte(this.tables["t_session_events"].fSequence, fromSequence)),
          );
    return scoped.orderBy(this.tables["t_session_events"].fSequence).execute() as unknown as EventRow[];
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.db.select().from(this.tables["t_sessions"]).execute() as unknown as Promise<SessionRow[]>;
  }

  async transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(this.txFor(tx)));
  }

  /** Bind the {@link BackendTx} primitives to one drizzle PG transaction handle. */
  private txFor(tx: PgAsyncTransaction<THKT>): BackendTx {
    return {
      upsertSession: (storage, incarnation) => this.upsertSession(tx, storage, incarnation),
      getHead: (id) => this.getHead(tx, id),
      insertEvents: (events) => this.insertEvents(tx, events),
      insertBridges: (rows) => this.insertBridges(tx, rows),
      updateHead: (id, headEventId, headSequence) =>
        this.updateHead(tx, id, headEventId, headSequence),
      bumpRevision: (id) => this.bumpRevision(tx, id),
      deleteBridgeTail: (id, fromSequence) => this.deleteBridgeTail(tx, id, fromSequence),
      getPrevBridge: (id, sequence) => this.getPrevBridge(tx, id, sequence),
      getLastBridge: (id) => this.getLastBridge(tx, id),
      updateBridgeFields: (id, sequence, fields) =>
        this.updateBridgeFields(tx, id, sequence, fields),
    };
  }

  // --- meta helpers ---

  private async readMeta(exec: PgAsyncDatabase<THKT>, key: string): Promise<string | undefined> {
    const rows = await exec
      .select({ fValue: this.tables["t_schema_meta"].fValue })
      .from(this.tables["t_schema_meta"])
      .where(eq(this.tables["t_schema_meta"].fKey, key))
      .execute();
    return rows[0]?.fValue;
  }

  // --- row primitives (transaction-internal) ---

  private async upsertSession(
    exec: PgAsyncDatabase<THKT>,
    storage: SessionStorageMetadata,
    incarnation: string,
  ): Promise<void> {
    await exec
      .insert(this.tables["t_sessions"])
      .values(sessionInsertRow(storage, incarnation))
      .onConflictDoUpdate({
        target: this.tables["t_sessions"].fSessionId,
        set: sessionConflictRow(storage),
      })
      .execute();
  }

  private async getHead(
    exec: PgAsyncDatabase<THKT>,
    id: SessionId,
  ): Promise<Pick<SessionRow, "fHeadEventId" | "fHeadSequence">> {
    const head = (
      await exec
        .select({ fHeadEventId: this.tables["t_sessions"].fHeadEventId, fHeadSequence: this.tables["t_sessions"].fHeadSequence })
        .from(this.tables["t_sessions"])
        .where(eq(this.tables["t_sessions"].fSessionId, id))
        .execute()
    )[0] as Pick<SessionRow, "fHeadEventId" | "fHeadSequence"> | undefined;
    /* v8 ignore next -- appendBatch/commitRepair always materialize the row before reading the head */
    if (head === undefined) throw new Error(`session "${id}" has no materialized row`);
    return head;
  }

  /** 多行 INSERT 分批上限（与 SQLite 的绑定参数上限同源防护；PG 65535）。 */
  private static readonly INSERT_BATCH_ROWS = 1000;

  private async insertEvents(exec: PgAsyncDatabase<THKT>, events: EventInsert[]): Promise<void> {
    if (events.length === 0) return;
    for (let i = 0; i < events.length; i += PostgresBackend.INSERT_BATCH_ROWS) {
      await exec
        .insert(this.tables["t_events"])
        .values(
          events.slice(i, i + PostgresBackend.INSERT_BATCH_ROWS).map((event) => ({ ...event })),
        )
        .execute();
    }
  }

  private async insertBridges(
    exec: PgAsyncDatabase<THKT>,
    rows: Array<{
      fSessionId: SessionId;
      fEventId: string;
      fSequence: number;
      fOriginalSeq: number;
      fSurfaceOp: string | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += PostgresBackend.INSERT_BATCH_ROWS) {
      await exec
        .insert(this.tables["t_session_events"])
        .values(rows.slice(i, i + PostgresBackend.INSERT_BATCH_ROWS).map((row) => ({ ...row })))
        .execute();
    }
  }

  private async updateHead(
    exec: PgAsyncDatabase<THKT>,
    id: SessionId,
    headEventId: string,
    headSequence: number,
  ): Promise<void> {
    await exec
      .update(this.tables["t_sessions"])
      .set({ fHeadEventId: headEventId, fHeadSequence: headSequence })
      .where(eq(this.tables["t_sessions"].fSessionId, id))
      .execute();
  }

  private async bumpRevision(exec: PgAsyncDatabase<THKT>, id: SessionId): Promise<void> {
    await exec
      .update(this.tables["t_sessions"])
      .set({ fRevision: sql`${this.tables["t_sessions"].fRevision} + 1` })
      .where(eq(this.tables["t_sessions"].fSessionId, id))
      .execute();
  }

  private async deleteBridgeTail(
    exec: PgAsyncDatabase<THKT>,
    id: SessionId,
    fromSequence: number,
  ): Promise<void> {
    await exec
      .delete(this.tables["t_session_events"])
      .where(and(eq(this.tables["t_session_events"].fSessionId, id), gte(this.tables["t_session_events"].fSequence, fromSequence)))
      .execute();
  }

  private async getPrevBridge(
    exec: PgAsyncDatabase<THKT>,
    id: SessionId,
    sequence: number,
  ): Promise<{ fEventId: string; fSequence: number } | undefined> {
    return (
      await exec
        .select({ fEventId: this.tables["t_session_events"].fEventId, fSequence: this.tables["t_session_events"].fSequence })
        .from(this.tables["t_session_events"])
        .where(and(eq(this.tables["t_session_events"].fSessionId, id), eq(this.tables["t_session_events"].fSequence, sequence)))
        .execute()
    )[0] as { fEventId: string; fSequence: number } | undefined;
  }

  private async getLastBridge(
    exec: PgAsyncDatabase<THKT>,
    id: SessionId,
  ): Promise<{ fEventId: string; fSequence: number } | undefined> {
    return (
      await exec
        .select({ fEventId: this.tables["t_session_events"].fEventId, fSequence: this.tables["t_session_events"].fSequence })
        .from(this.tables["t_session_events"])
        .where(eq(this.tables["t_session_events"].fSessionId, id))
        .orderBy(desc(this.tables["t_session_events"].fSequence))
        .limit(1)
        .execute()
    )[0] as { fEventId: string; fSequence: number } | undefined;
  }

  /** The joined event-row projection shared by whole-log and suffix reads. */
  private eventRows(exec: PgAsyncDatabase<THKT>) {
    return exec
      .select({
        fEventId: this.tables["t_session_events"].fEventId,
        fSequence: this.tables["t_session_events"].fSequence,
        fOriginalSeq: this.tables["t_session_events"].fOriginalSeq,
        fType: this.tables["t_events"].fType,
        fKind: this.tables["t_events"].fKind,
        fRole: this.tables["t_events"].fRole,
        fName: this.tables["t_events"].fName,
        fActionId: this.tables["t_events"].fActionId,
        fCreatedAt: this.tables["t_events"].fCreatedAt,
        fData: this.tables["t_events"].fData,
        fSurfaceOp: this.tables["t_session_events"].fSurfaceOp,
      })
      .from(this.tables["t_session_events"])
      .innerJoin(this.tables["t_events"], eq(this.tables["t_session_events"].fEventId, this.tables["t_events"].fEventId));
  }

  private async updateBridgeFields(
    exec: PgAsyncDatabase<THKT>,
    id: SessionId,
    sequence: number,
    fields: {
      fSurfaceOp?: string | null;
      fOriginalSeq?: number;
    },
  ): Promise<void> {
    await exec
      .update(this.tables["t_session_events"])
      .set({
        ...(fields.fSurfaceOp === undefined ? {} : { fSurfaceOp: fields.fSurfaceOp }),
        ...(fields.fOriginalSeq === undefined ? {} : { fOriginalSeq: fields.fOriginalSeq }),
      })
      .where(and(eq(this.tables["t_session_events"].fSessionId, id), eq(this.tables["t_session_events"].fSequence, sequence)))
      .execute();
  }
}
