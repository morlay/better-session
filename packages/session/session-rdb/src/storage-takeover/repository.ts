import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from "@deepseek-ai/dsh-session";
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

export interface StorageRepositoryHost {
  db: () => Promise<unknown>;

  /** 不经 await、直接拿到的数据库句柄；未开放时只走异步的 `db`。 */
  dbDirect?: () => unknown;

  tables: Record<string, unknown>;

  writeAtomically: <T>(fn: () => Promise<T>) => Promise<T>;
}

async function allRows<T>(query: unknown): Promise<T[]> {
  const q = query as { all?: () => T[] };
  if (typeof q.all === "function") return q.all();
  return (await query) as T[];
}

async function oneRow<T>(query: unknown): Promise<T | undefined> {
  const q = query as { get?: () => T | undefined };
  if (typeof q.get === "function") return q.get();
  const rows = (await query) as T[];
  return rows[0];
}

async function runQuery(query: unknown): Promise<void> {
  const q = query as { run?: () => unknown };
  if (typeof q.run === "function") {
    q.run();
    return;
  }
  await query;
}

interface SessionIdentityRow {
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fSeedLength: number | null;
}

interface ProjcacheRowRecord {
  fSessionId: string;
  fKey: string;
  fVer: number;
  fSeq: number;
  fVal: string;
}

function identityOfSession(row: SessionIdentityRow): CheckpointIdentity {
  return {
    formatVersion: row.fVersion,
    createdAt: row.fCreatedAt,
    ...(row.fCwd === null ? {} : { cwd: row.fCwd }),
    isSeeded: row.fSeedLength !== null,
    ...(row.fSeedLength === null ? {} : { inheritedEventCount: SessionLogOffset(row.fSeedLength) }),
  };
}

function seqCursor(seq: number): SessionSeqCursor {
  return seq === -1 ? -1 : SessionSeq(seq);
}

function pendingMutationOf(row: {
  fPendingOperation: string | null;
  fPendingWorkspaceId: string | null;
}): WorkspaceDomainState["pendingMutation"] {
  const operation = row.fPendingOperation;
  if (operation !== "create" && operation !== "delete") return undefined;
  return { operation, workspaceId: (row.fPendingWorkspaceId ?? "") as WorkspaceId };
}

export function createStorageRepository(host: StorageRepositoryHost): StorageRepository {
  const tables = host.tables as Record<string, any>;
  const tUnits = tables["t_storage_units"]!;
  const tSessions = tables["t_sessions"]!;
  const tWorkspaces = tables["t_workspaces"]!;
  const tWorkspaceSessions = tables["t_workspace_sessions"]!;
  const tWorkspaceState = tables["t_workspace_state"]!;
  const tProjcacheRows = tables["t_session_projcache_row"]!;

  const sessionIdentity = {
    fSessionId: tSessions.fSessionId,
    fVersion: tSessions.fVersion,
    fCreatedAt: tSessions.fCreatedAt,
    fCwd: tSessions.fCwd,
    fSeedLength: tSessions.fSeedLength,
  };

  const dbx = async (): Promise<any> => (await host.db()) as any;

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

        await runQuery(db.update(tWorkspaces).set({ fPosition: -1 }));
        for (const [position, workspaceId] of state.workspaceIds.entries()) {
          await runQuery(
            db
              .update(tWorkspaces)
              .set({ fPosition: position })
              .where(eq(tWorkspaces.fWorkspaceId, workspaceId)),
          );
        }

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
                  and(isNotNull(tSessions.fArchivedAt), notInArray(tSessions.fSessionId, archived)),
                ),
        );
        const stamp = Date.now();
        for (const sessionId of archived) {
          await runQuery(
            db
              .insert(tSessions)
              .values({
                fSessionId: sessionId,
                fHeadEventId: "",
                fHeadSequence: -1,
                fVersion: SESSION_FORMAT_VERSION,
                fCreatedAt: stamp,
                fCwd: null,
                fParentSession: null,
                fSeedLength: null,
                fOrigin: null,
                fDelegationDepth: null,
                fIncarnation: randomUUID(),
                fRevision: 0,
                fArchivedAt: stamp,
              })
              .onConflictDoUpdate({
                target: tSessions.fSessionId,

                set: { fArchivedAt: sql`COALESCE(${tSessions.fArchivedAt}, ${stamp})` },
              }),
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
        const entry = entries.get(row.fSessionId);
        if (entry === undefined) continue;
        entry.rows[row.fKey] = {
          ver: row.fVer,
          seq: seqCursor(row.fSeq),
          val: JSON.parse(row.fVal),
        } satisfies ProjectionCheckpointRow;
      }

      return [...entries.values()].filter((entry) => Object.keys(entry.rows).length > 0);
    },

    async putProjcache(sessionId: string, rows: ProjectionCheckpoint): Promise<void> {
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

    async pruneStaleProjcache(): Promise<number> {
      const db = await dbx();
      const stale = await allRows<{ fSessionId: string }>(
        db
          .select({ fSessionId: tProjcacheRows.fSessionId })
          .from(tProjcacheRows)
          .where(
            and(
              lt(tProjcacheRows.fSeq, 0),
              inArray(
                tProjcacheRows.fSessionId,
                db
                  .select({ fSessionId: tSessions.fSessionId })
                  .from(tSessions)
                  .where(gte(tSessions.fHeadSequence, 0)),
              ),
            ),
          ),
      );
      if (stale.length === 0) return 0;
      await runQuery(
        db.delete(tProjcacheRows).where(
          inArray(
            tProjcacheRows.fSessionId,
            stale.map((row) => row.fSessionId),
          ),
        ),
      );
      return stale.length;
    },

    ...(host.dbDirect === undefined
      ? {}
      : {
          readProjcacheDirect: (sessionId: string): StoredProjcacheEntry | undefined => {
            const db = host.dbDirect!() as any;
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
          readSessionTitleDirect: (
            sessionId: string,
          ): { title: string; seq: number } | undefined => {
            const db = host.dbDirect!() as any;
            const row = db
              .select({ fTitle: tSessions.fTitle, fTitleSeq: tSessions.fTitleSeq })
              .from(tSessions)
              .where(eq(tSessions.fSessionId, sessionId))
              .get() as { fTitle: string | null; fTitleSeq: number | null } | undefined;
            if (row === undefined || row.fTitle === null || row.fTitleSeq === null)
              return undefined;
            return { title: row.fTitle, seq: row.fTitleSeq };
          },
        }),
  };
}
