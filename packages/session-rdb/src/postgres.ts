import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, gte, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgAsyncTransaction } from "drizzle-orm/pg-core";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import {
  type Backend,
  type BackendTx,
  type EventInsert,
  type EventRow,
  type SessionRow,
} from "./backend.ts";
import { toPostgresSchema } from "./adapters/index.ts";
import { postgresTableDefs } from "./entities/index.ts";
import { sessionConflictRow, sessionInsertRow } from "./log.ts";

/** drizzle-kit 生成的迁移目录（随包根 drizzle/ 发布；src/dist 形态经相对 URL 统一解析）。 */
const postgresMigrationsDir = fileURLToPath(new URL("../drizzle/postgres/", import.meta.url));

export interface PostgresBackendOptions {
  identityBase: string;

  schema?: string;

  close: () => Promise<void>;
}

export class PostgresBackend implements Backend {
  readonly kind = "postgres" as const;
  storeIdentity!: string;

  private readonly tables: Record<string, any>;

  constructor(
    private readonly db: NodePgDatabase,
    private readonly options: PostgresBackendOptions,
  ) {
    this.tables = toPostgresSchema(postgresTableDefs, this.options.schema ?? "public");
  }

  async open(): Promise<void> {
    const schema = this.options.schema ?? "public";
    // drizzle-kit 迁移：v2 baseline 由旧版本建表（首次打开时标记为已应用），
    // 本版本只执行 v3 diff（删 f_original_seq）。
    const qualifiedMeta = schema === "public" ? "t_schema_meta" : `"${schema}".t_schema_meta`;
    const probe = (await this.db.execute(
      sql`SELECT to_regclass(${qualifiedMeta}) IS NOT NULL AS exists`,
    )) as unknown as { rows: { exists: boolean }[] };
    const metaExists = probe.rows[0]?.exists === true;
    if (metaExists) {
      const version = await this.readMeta(this.db, "schema_version");
      if (version === "2") {
        await this.baselineV2();
      }
    }
    await migrate(this.db, { migrationsFolder: postgresMigrationsDir });
    const storeId = await this.db.transaction(async (tx) => {
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
      const id = store[0]?.fStoreId;
      if (id === undefined || id.length === 0) {
        throw new Error("session database has no valid store identity");
      }
      return id;
    });
    this.storeIdentity = `${this.options.identityBase}:store:${storeId}`;
  }

  /** 标记 v2 baseline 已应用（迁移表 v1 结构：id/hash/created_at/name/applied_at）。 */
  private async baselineV2(): Promise<void> {
    const dir = readdirSync(postgresMigrationsDir).find((name) => name.endsWith("_v2_initial"));
    if (dir === undefined) throw new Error("missing v2 baseline migration in drizzle/postgres");
    await this.db.execute(sql`
      CREATE SCHEMA IF NOT EXISTS drizzle
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint,
        name text,
        applied_at timestamp with time zone DEFAULT now()
      )
    `);
    await this.db.execute(
      sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ('baseline', 0, ${dir})`,
    );
  }

  async close(): Promise<void> {
    await this.options.close();
  }

  async getSession(id: SessionId): Promise<SessionRow | undefined> {
    return (
      await this.db
        .select()
        .from(this.tables["t_sessions"])
        .where(eq(this.tables["t_sessions"].fSessionId, id))
        .execute()
    )[0] as SessionRow | undefined;
  }

  async getEventRows(id: SessionId, fromSequence?: number): Promise<EventRow[]> {
    const scoped =
      fromSequence === undefined
        ? this.eventRows(this.db).where(eq(this.tables["t_session_events"].fSessionId, id))
        : this.eventRows(this.db).where(
            and(
              eq(this.tables["t_session_events"].fSessionId, id),
              gte(this.tables["t_session_events"].fSequence, fromSequence),
            ),
          );
    return scoped
      .orderBy(this.tables["t_session_events"].fSequence)
      .execute() as unknown as EventRow[];
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.db.select().from(this.tables["t_sessions"]).execute() as unknown as Promise<
      SessionRow[]
    >;
  }

  async transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(this.txFor(tx)));
  }

  private txFor(tx: PgAsyncTransaction<NodePgQueryResultHKT>): BackendTx {
    return {
      upsertSession: (storage, incarnation) => this.upsertSession(tx, storage, incarnation),
      getHead: (id) => this.getHead(tx, id),
      getSeedLength: (id) => this.getSeedLength(tx, id),
      updateSeedLength: (id, seedLength) => this.updateSeedLength(tx, id, seedLength),
      insertEvents: (events) => this.insertEvents(tx, events),
      insertBridges: (rows) => this.insertBridges(tx, rows),
      updateHead: (id, headEventId, headSequence) =>
        this.updateHead(tx, id, headEventId, headSequence),
      bumpRevision: (id) => this.bumpRevision(tx, id),
      deleteBridgeTail: (id, fromSequence) => this.deleteBridgeTail(tx, id, fromSequence),
      getPrevBridge: (id, sequence) => this.getPrevBridge(tx, id, sequence),
    };
  }

  // --- meta helpers ---

  private async readMeta(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    key: string,
  ): Promise<string | undefined> {
    const rows = await exec
      .select({ fValue: this.tables["t_schema_meta"].fValue })
      .from(this.tables["t_schema_meta"])
      .where(eq(this.tables["t_schema_meta"].fKey, key))
      .execute();
    return rows[0]?.fValue;
  }

  // --- row primitives (transaction-internal) ---

  private async upsertSession(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
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
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    id: SessionId,
  ): Promise<Pick<SessionRow, "fHeadEventId" | "fHeadSequence">> {
    const head = (
      await exec
        .select({
          fHeadEventId: this.tables["t_sessions"].fHeadEventId,
          fHeadSequence: this.tables["t_sessions"].fHeadSequence,
        })
        .from(this.tables["t_sessions"])
        .where(eq(this.tables["t_sessions"].fSessionId, id))
        .execute()
    )[0] as Pick<SessionRow, "fHeadEventId" | "fHeadSequence"> | undefined;
    /* v8 ignore next -- appendBatch/commitRepair always materialize the row before reading the head */
    if (head === undefined) throw new Error(`session "${id}" has no materialized row`);
    return head;
  }

  private async getSeedLength(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    id: SessionId,
  ): Promise<number | null> {
    const row = (
      await exec
        .select({ fSeedLength: this.tables["t_sessions"].fSeedLength })
        .from(this.tables["t_sessions"])
        .where(eq(this.tables["t_sessions"].fSessionId, id))
        .execute()
    )[0] as { fSeedLength: number | null } | undefined;
    /* v8 ignore next -- rewind always materializes the row before reading the seed length */
    if (row === undefined) throw new Error(`session "${id}" has no materialized row`);
    return row.fSeedLength;
  }

  private async updateSeedLength(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    id: SessionId,
    seedLength: number,
  ): Promise<void> {
    await exec
      .update(this.tables["t_sessions"])
      .set({ fSeedLength: seedLength })
      .where(eq(this.tables["t_sessions"].fSessionId, id))
      .execute();
  }

  private static readonly INSERT_BATCH_ROWS = 1000;

  private async insertEvents(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    events: EventInsert[],
  ): Promise<void> {
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
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    rows: Array<{
      fSessionId: SessionId;
      fEventId: string;
      fSequence: number;
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
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
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

  private async bumpRevision(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    id: SessionId,
  ): Promise<void> {
    await exec
      .update(this.tables["t_sessions"])
      .set({ fRevision: sql`${this.tables["t_sessions"].fRevision} + 1` })
      .where(eq(this.tables["t_sessions"].fSessionId, id))
      .execute();
  }

  private async deleteBridgeTail(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    id: SessionId,
    fromSequence: number,
  ): Promise<void> {
    await exec
      .delete(this.tables["t_session_events"])
      .where(
        and(
          eq(this.tables["t_session_events"].fSessionId, id),
          gte(this.tables["t_session_events"].fSequence, fromSequence),
        ),
      )
      .execute();
  }

  private async getPrevBridge(
    exec: PgAsyncDatabase<NodePgQueryResultHKT>,
    id: SessionId,
    sequence: number,
  ): Promise<{ fEventId: string; fSequence: number } | undefined> {
    return (
      await exec
        .select({
          fEventId: this.tables["t_session_events"].fEventId,
          fSequence: this.tables["t_session_events"].fSequence,
        })
        .from(this.tables["t_session_events"])
        .where(
          and(
            eq(this.tables["t_session_events"].fSessionId, id),
            eq(this.tables["t_session_events"].fSequence, sequence),
          ),
        )
        .execute()
    )[0] as { fEventId: string; fSequence: number } | undefined;
  }

  private eventRows(exec: PgAsyncDatabase<NodePgQueryResultHKT>) {
    return exec
      .select({
        fEventId: this.tables["t_session_events"].fEventId,
        fSequence: this.tables["t_session_events"].fSequence,
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
      .innerJoin(
        this.tables["t_events"],
        eq(this.tables["t_session_events"].fEventId, this.tables["t_events"].fEventId),
      );
  }
}
