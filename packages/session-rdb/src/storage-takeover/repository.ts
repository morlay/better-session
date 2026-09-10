/**
 * storages 接管表的方言无关实现：SQLite 与 PostgreSQL 的 drizzle 查询构建器
 * 共享同一套调用形状（SQLite 走同步 `.all()`/`.get()`/`.run()`，PostgreSQL
 * 走 thenable），差别由本模块的执行 helper 吸收。
 *
 * workspace 域是权威数据：记录、归属、显示顺序与归档集都拆成语义表，每次写入
 * 在介质事务内完成（`host.writeAtomically`），不留部分应用的中间态。
 */

import { and, eq, gte, isNotNull, notInArray, sql } from "drizzle-orm";
import { SessionId, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionSeqCursor } from "@deepseek-ai/dsh-session";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import type {
  CheckpointIdentity,
  ProjectionCheckpoint,
  ProjectionCheckpointRow,
  StorageRepository,
  StoredProjcacheEntry,
  WorkspaceDomainState,
  WorkspaceRecord,
} from "./types.ts";

/** 注入口：介质句柄 + 方言表对象 + 事务。 */
export interface StorageRepositoryHost {
  /** 解析 drizzle 句柄；介质未就绪时调用方等待其 open 完成。 */
  db: () => Promise<unknown>;
  /**
   * 同步驱动的 drizzle 句柄（SQLite）。缺席时 {@link StorageRepository.readProjcacheSync}
   * 不提供：异步驱动（PostgreSQL）没有同步读，调用方只能维护写穿镜像。
   * @returns the open drizzle handle.
   */
  dbSync?: () => unknown;
  /** `toSqliteSchema` / `toPostgresSchema` 产出的方言表对象。 */
  tables: Record<string, unknown>;
  /**
   * Run `fn` inside one medium transaction: every statement issued through
   * {@link StorageRepositoryHost.db} while it runs joins that transaction, and
   * a failure rolls the whole write back.
   * @param fn - statements to run atomically.
   * @returns the callback's result.
   */
  writeAtomically: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** 多行查询：SQLite 同步 `.all()`，PostgreSQL await。 */
async function allRows<T>(query: unknown): Promise<T[]> {
  const q = query as { all?: () => T[] };
  if (typeof q.all === "function") return q.all();
  return (await query) as T[];
}

/** 单行查询：SQLite 同步 `.get()`，PostgreSQL await 后取首行。 */
async function oneRow<T>(query: unknown): Promise<T | undefined> {
  const q = query as { get?: () => T | undefined };
  if (typeof q.get === "function") return q.get();
  const rows = (await query) as T[];
  return rows[0];
}

/** 写入语句：SQLite 同步 `.run()`，PostgreSQL await。 */
async function runQuery(query: unknown): Promise<void> {
  const q = query as { run?: () => unknown };
  if (typeof q.run === "function") {
    q.run();
    return;
  }
  await query;
}

/** `t_sessions` 上承载 checkpoint identity 的列（与投影行 1:1，不另存一份）。 */
interface SessionIdentityRow {
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fSeedLength: number | null;
}

/** `t_session_projcache_row` 的行形状（存储层视角）。 */
interface ProjcacheRowRecord {
  fSessionId: string;
  fKey: string;
  fVer: number;
  fSeq: number;
  fVal: string;
}

/** 一行会话元数据 → 上游 `CheckpointIdentity`。 */
function identityOfSession(row: SessionIdentityRow): CheckpointIdentity {
  return {
    formatVersion: row.fVersion,
    createdAt: row.fCreatedAt,
    ...(row.fCwd === null ? {} : { cwd: row.fCwd }),
    isSeeded: row.fSeedLength !== null,
    ...(row.fSeedLength === null
      ? {}
      : { inheritedEventCount: SessionLogOffset(row.fSeedLength) }),
  };
}

/** 存储的整数水位 → 上游 seq cursor（-1 是空日志哨兵）。 */
function seqCursor(seq: number): SessionSeqCursor {
  return seq === -1 ? -1 : SessionSeq(seq);
}

/** 两写标记的两列 → 上游 `pendingMutation`（未知操作按缺失处理）。 */
function pendingMutationOf(row: {
  fPendingOperation: string | null;
  fPendingWorkspaceId: string | null;
}): WorkspaceDomainState["pendingMutation"] {
  const operation = row.fPendingOperation;
  if (operation !== "create" && operation !== "delete") return undefined;
  return { operation, workspaceId: (row.fPendingWorkspaceId ?? "") as WorkspaceId };
}

/**
 * 构建一个介质的 storages 接管访问层。
 * @param host - 介质句柄、方言表对象与事务执行器。
 * @returns 方言无关的访问层。
 */
export function createStorageRepository(host: StorageRepositoryHost): StorageRepository {
  /* eslint-disable @typescript-eslint/no-explicit-any -- drizzle 双方言表对象只在运行期共享查询形状 */
  const tables = host.tables as Record<string, any>;
  const tUnits = tables["t_storage_units"]!;
  const tSessions = tables["t_sessions"]!;
  const tWorkspaces = tables["t_workspaces"]!;
  const tWorkspaceSessions = tables["t_workspace_sessions"]!;
  const tWorkspaceState = tables["t_workspace_state"]!;
  const tProjcacheRows = tables["t_session_projcache_row"]!;
  /** checkpoint identity 的列投影：直接复用会话行，不再单存记录头。 */
  const sessionIdentity = {
    fSessionId: tSessions.fSessionId,
    fVersion: tSessions.fVersion,
    fCreatedAt: tSessions.fCreatedAt,
    fCwd: tSessions.fCwd,
    fSeedLength: tSessions.fSeedLength,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const dbx = async (): Promise<any> => (await host.db()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

  return {
    async readUnitVersion(name: string): Promise<number | undefined> {
      const db = await dbx();
      const row = await oneRow<{ fVersion: number }>(
        db.select().from(tUnits).where(eq(tUnits.fName, name)),
      );
      return row?.fVersion;
    },

    async insertUnitVersion(name: string, version: number): Promise<void> {
      const db = await dbx();
      await runQuery(
        db.insert(tUnits).values({ fName: name, fVersion: version }).onConflictDoNothing(),
      );
    },

    async listWorkspaces(): Promise<Array<{ id: string; record: WorkspaceRecord }>> {
      const db = await dbx();
      const rows = await allRows<{
        fWorkspaceId: string;
        fPath: string;
        fTitle: string;
        fCreatedAt: string;
        fUpdatedAt: string;
      }>(db.select().from(tWorkspaces));
      const links = await allRows<{
        fWorkspaceId: string;
        fSessionId: string;
        fPosition: number;
      }>(db.select().from(tWorkspaceSessions));
      const sessions = new Map<string, Array<{ id: string; position: number }>>();
      for (const link of links) {
        const owned = sessions.get(link.fWorkspaceId) ?? [];
        owned.push({ id: link.fSessionId, position: link.fPosition });
        sessions.set(link.fWorkspaceId, owned);
      }
      return rows.map((row) => ({
        id: row.fWorkspaceId,
        record: {
          path: row.fPath,
          title: row.fTitle,
          sessionIds: (sessions.get(row.fWorkspaceId) ?? [])
            .sort((left, right) => left.position - right.position)
            .map((entry) => SessionId(entry.id)),
          createdAt: row.fCreatedAt,
          updatedAt: row.fUpdatedAt,
        },
      }));
    },

    async putWorkspace(id: string, record: WorkspaceRecord): Promise<void> {
      await host.writeAtomically(async () => {
        const db = await dbx();
        const values = {
          fWorkspaceId: id,
          fPath: record.path,
          fTitle: record.title,
          fCreatedAt: record.createdAt,
          fUpdatedAt: record.updatedAt,
        };
        await runQuery(
          db
            .insert(tWorkspaces)
            .values(values)
            .onConflictDoUpdate({ target: tWorkspaces.fWorkspaceId, set: values }),
        );
        // 归属整体替换：DELETE + 有序 INSERT 在同一事务内，读不到中间态。
        await runQuery(
          db.delete(tWorkspaceSessions).where(eq(tWorkspaceSessions.fWorkspaceId, id)),
        );
        const links = record.sessionIds.map((sessionId, position) => ({
          fWorkspaceId: id,
          fSessionId: sessionId,
          fPosition: position,
        }));
        if (links.length > 0) await runQuery(db.insert(tWorkspaceSessions).values(links));
      });
    },

    async deleteWorkspace(id: string): Promise<void> {
      await host.writeAtomically(async () => {
        const db = await dbx();
        await runQuery(
          db.delete(tWorkspaceSessions).where(eq(tWorkspaceSessions.fWorkspaceId, id)),
        );
        await runQuery(db.delete(tWorkspaces).where(eq(tWorkspaces.fWorkspaceId, id)));
      });
    },

    async readWorkspaceState(): Promise<WorkspaceDomainState | null> {
      const db = await dbx();
      const row = await oneRow<{
        fInitialized: number;
        fPendingOperation: string | null;
        fPendingWorkspaceId: string | null;
      }>(db.select().from(tWorkspaceState).where(eq(tWorkspaceState.fSingleton, 1)));
      if (row === undefined) return null;
      const ordered = await allRows<{ fWorkspaceId: string }>(
        db
          .select()
          .from(tWorkspaces)
          .where(gte(tWorkspaces.fPosition, 0))
          .orderBy(tWorkspaces.fPosition),
      );
      const archives = await allRows<{ fSessionId: string }>(
        db
          .select({ fSessionId: tSessions.fSessionId })
          .from(tSessions)
          .where(isNotNull(tSessions.fArchivedAt))
          .orderBy(tSessions.fArchivedAt),
      );
      const pendingMutation = pendingMutationOf(row);
      return {
        initialized: row.fInitialized !== 0,
        workspaceIds: ordered.map((entry) => entry.fWorkspaceId as WorkspaceId),
        archivedSessionIds: archives.map((entry) => entry.fSessionId as SessionId),
        ...(pendingMutation === undefined ? {} : { pendingMutation }),
      };
    },

    async writeWorkspaceState(state: WorkspaceDomainState): Promise<void> {
      await host.writeAtomically(async () => {
        const db = await dbx();
        const pending = state.pendingMutation as
          | { operation?: unknown; workspaceId?: unknown }
          | undefined;
        const values = {
          fSingleton: 1,
          fInitialized: state.initialized ? 1 : 0,
          fPendingOperation:
            pending === undefined || typeof pending.operation !== "string"
              ? null
              : pending.operation,
          fPendingWorkspaceId:
            pending === undefined || typeof pending.workspaceId !== "string"
              ? null
              : pending.workspaceId,
        };
        await runQuery(
          db
            .insert(tWorkspaceState)
            .values(values)
            .onConflictDoUpdate({ target: tWorkspaceState.fSingleton, set: values }),
        );
        // 显示顺序整体替换：先清位，再按数组顺序定位（不在集合里的记录保持 -1）。
        await runQuery(db.update(tWorkspaces).set({ fPosition: -1 }));
        for (const [position, workspaceId] of state.workspaceIds.entries()) {
          await runQuery(
            db
              .update(tWorkspaces)
              .set({ fPosition: position })
              .where(eq(tWorkspaces.fWorkspaceId, workspaceId)),
          );
        }
        // 归档集整体替换：标记落在会话行（f_archived_at），未列出的会话清空标记。
        const archived = state.archivedSessionIds;
        await runQuery(
          archived.length === 0
            ? db
                .update(tSessions)
                .set({ fArchivedAt: null })
                .where(isNotNull(tSessions.fArchivedAt))
            : db
                .update(tSessions)
                .set({ fArchivedAt: null })
                .where(
                  and(
                    isNotNull(tSessions.fArchivedAt),
                    notInArray(tSessions.fSessionId, archived),
                  ),
                ),
        );
        const stamp = Date.now();
        for (const sessionId of archived) {
          // 首次归档时间保留：重复写入同一集合不刷新标记。
          await runQuery(
            db
              .update(tSessions)
              .set({ fArchivedAt: sql`COALESCE(${tSessions.fArchivedAt}, ${stamp})` })
              .where(eq(tSessions.fSessionId, sessionId)),
          );
        }
      });
    },

    async loadProjcache(): Promise<StoredProjcacheEntry[]> {
      const db = await dbx();
      const rows = await allRows<ProjcacheRowRecord>(db.select().from(tProjcacheRows));
      if (rows.length === 0) return [];
      const sessions = await allRows<SessionIdentityRow & { fSessionId: string }>(
        db.select(sessionIdentity).from(tSessions),
      );
      const entries = new Map<string, StoredProjcacheEntry>();
      for (const session of sessions) {
        entries.set(session.fSessionId, {
          sessionId: SessionId(session.fSessionId),
          identity: identityOfSession(session),
          rows: {},
        });
      }
      for (const row of rows) {
        // 没有会话行的行读作缺失：checkpoint 的 identity 由会话行承载。
        const entry = entries.get(row.fSessionId);
        if (entry === undefined) continue;
        entry.rows[row.fKey] = {
          ver: row.fVer,
          seq: seqCursor(row.fSeq),
          val: JSON.parse(row.fVal),
        } satisfies ProjectionCheckpointRow;
      }
      // 没有投影行的会话没有 checkpoint（避免把空记录装进异步镜像）。
      return [...entries.values()].filter((entry) => Object.keys(entry.rows).length > 0);
    },

    async putProjcache(
      sessionId: string,
      rows: ProjectionCheckpoint,
    ): Promise<void> {
      await host.writeAtomically(async () => {
        const db = await dbx();
        await runQuery(db.delete(tProjcacheRows).where(eq(tProjcacheRows.fSessionId, sessionId)));
        const values = Object.entries(rows).map(([key, row]) => ({
          fSessionId: sessionId,
          fKey: key,
          fVer: row.ver,
          fSeq: row.seq,
          fVal: JSON.stringify(row.val),
        }));
        if (values.length > 0) await runQuery(db.insert(tProjcacheRows).values(values));
      });
    },

    async deleteProjcache(sessionId: string): Promise<void> {
      const db = await dbx();
      await runQuery(db.delete(tProjcacheRows).where(eq(tProjcacheRows.fSessionId, sessionId)));
    },

    // 同步驱动（SQLite）才有：读路径直接查介质，进程内不维护 checkpoint 镜像。
    ...(host.dbSync === undefined
      ? {}
      : {
          readProjcacheSync: (sessionId: string): StoredProjcacheEntry | undefined => {
            const db = host.dbSync!() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
            const stored = db
              .select()
              .from(tProjcacheRows)
              .where(eq(tProjcacheRows.fSessionId, sessionId))
              .all() as ProjcacheRowRecord[];
            if (stored.length === 0) return undefined;
            const session = db
              .select(sessionIdentity)
              .from(tSessions)
              .where(eq(tSessions.fSessionId, sessionId))
              .get() as (SessionIdentityRow & { fSessionId: string }) | undefined;
            // 没有会话行（未物化或已删）就没有可校验的 identity → 读作缺失。
            if (session === undefined) return undefined;
            const rows: ProjectionCheckpoint = {};
            for (const row of stored) {
              rows[row.fKey] = {
                ver: row.fVer,
                seq: seqCursor(row.fSeq),
                val: JSON.parse(row.fVal),
              };
            }
            return { sessionId: SessionId(sessionId), identity: identityOfSession(session), rows };
          },
          readSessionTitleSync: (sessionId: string): { title: string; seq: number } | undefined => {
            const db = host.dbSync!() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
            const row = db
              .select({ fTitle: tSessions.fTitle, fTitleSeq: tSessions.fTitleSeq })
              .from(tSessions)
              .where(eq(tSessions.fSessionId, sessionId))
              .get() as { fTitle: string | null; fTitleSeq: number | null } | undefined;
            if (row === undefined || row.fTitle === null || row.fTitleSeq === null) return undefined;
            return { title: row.fTitle, seq: row.fTitleSeq };
          },
        }),
  };
}
