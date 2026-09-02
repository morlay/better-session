import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";

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

  fOriginalSeq: number;

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

  insertEvents(events: EventInsert[]): Promise<void>;

  insertBridges(
    rows: Array<{
      fSessionId: SessionId;
      fEventId: string;
      fSequence: number;
      fOriginalSeq: number;
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

  getLastBridge(id: SessionId): Promise<{ fEventId: string; fSequence: number } | undefined>;
}

export interface Backend {
  readonly kind: "sqlite" | "postgres";

  readonly storeIdentity: string;

  open(): Promise<void>;

  getSession(id: SessionId): Promise<SessionRow | undefined>;

  getSeqMapRows(id: SessionId): Promise<Array<{ fSequence: number; fOriginalSeq: number }>>;

  getEventRows(id: SessionId, fromSequence?: number): Promise<EventRow[]>;

  listSessions(): Promise<SessionRow[]>;

  transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
