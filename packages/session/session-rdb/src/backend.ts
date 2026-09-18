import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import type { StorageRepository } from "./storage-takeover/types.ts";

export interface SessionRow {
  fSessionId: string;

  fHeadEventId: string;
  fHeadSequence: number;
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fSeedLength: number | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;

  fIncarnation: string;

  fRevision: number;

  fArchivedAt: number | null;
}

export interface EventInsert {
  fEventId: string;
  fParentId: string;
  fType: string;
  fKind: string;
  fRole: string;
  fName: string;
  fActionId: string;
  fEncoding: string;
  fData: string;
  fCreatedAt: number;
}

export interface EventRow {
  fEventId: string;

  fSequence: number;

  fType: string;

  fKind: string;

  fRole: string;

  fName: string;

  fActionId: string;

  fCreatedAt: number;

  fData: string;

  fSurfaceOp: string | null;
}

export interface BackendTx {
  upsertSession(storage: SessionStorageMetadata, incarnation: string): Promise<void>;

  getHead(id: SessionId): Promise<Pick<SessionRow, "fHeadEventId" | "fHeadSequence">>;

  getSeedLength(id: SessionId): Promise<number | null>;

  updateSeedLength(id: SessionId, seedLength: number): Promise<void>;

  refreshTitle(id: SessionId): Promise<void>;

  insertEvents(events: EventInsert[]): Promise<void>;

  insertBridges(
    rows: Array<{
      fSessionId: SessionId;
      fEventId: string;
      fSequence: number;
      fSurfaceOp: string | null;
    }>,
  ): Promise<void>;

  updateHead(id: SessionId, headEventId: string, headSequence: number): Promise<void>;

  bumpRevision(id: SessionId): Promise<void>;

  deleteBridgeTail(id: SessionId, fromSequence: number): Promise<void>;

  getPrevBridge(
    id: SessionId,
    sequence: number,
  ): Promise<{ fEventId: string; fSequence: number } | undefined>;

  deleteSession(id: SessionId): Promise<void>;

  /** 批量删除整条会话：桥接行、workspace 归属行、投影行与会话行。 */
  deleteSessions(ids: SessionId[]): Promise<number>;
}

export interface Backend {
  readonly kind: "sqlite" | "postgres";

  readonly storeIdentity: string;

  readonly storage: StorageRepository;

  open(): Promise<void>;

  getSession(id: SessionId): Promise<SessionRow | undefined>;

  getEventRows(id: SessionId, fromSequence?: number): Promise<EventRow[]>;

  getEventTypeAt(id: SessionId, sequence: number): Promise<string | undefined>;

  getEventTypesBefore(
    id: SessionId,
    beforeSequence: number,
    limit: number,
  ): Promise<Array<Pick<EventRow, "fSequence" | "fType">>>;

  listSessions(): Promise<SessionRow[]>;

  transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T>;

  /** 删除已无桥接行引用的事件行（孤儿），返回删除行数。 */
  collectOrphans(): Promise<number>;

  /** 父会话已不存在（或没有父）的 subagent 会话：父被删后它们成了孤儿。 */
  listOrphanSubagentSessions(): Promise<SessionId[]>;

  /** 回收空间与统计（含 VACUUM）；不得在事务内执行。 */
  vacuum(): Promise<void>;

  close(): Promise<void>;
}
