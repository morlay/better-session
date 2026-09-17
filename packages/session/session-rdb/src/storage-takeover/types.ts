import type { SessionId } from "@deepseek-ai/dsh-session";
import type { CheckpointIdentity } from "@deepseek-ai/dsh-session-projection-cache";
import type {
  ProjectionCheckpoint,
  ProjectionCheckpointRow,
} from "@deepseek-ai/dsh-session-projection";
import type { WorkspaceDomainState, WorkspaceRecord } from "@deepseek-ai/dsh-workspace";

export type {
  CheckpointIdentity,
  ProjectionCheckpoint,
  ProjectionCheckpointRow,
  WorkspaceDomainState,
  WorkspaceRecord,
};

export interface StoredProjcacheEntry {
  sessionId: SessionId;
  identity: CheckpointIdentity;
  rows: ProjectionCheckpoint;
}

export interface StorageRepository {
  readUnitVersion(name: string): Promise<number | undefined>;

  insertUnitVersion(name: string, version: number): Promise<void>;

  listWorkspaces(): Promise<Array<{ id: string; record: WorkspaceRecord }>>;

  putWorkspace(id: string, record: WorkspaceRecord): Promise<void>;

  deleteWorkspace(id: string): Promise<void>;

  readWorkspaceState(): Promise<WorkspaceDomainState | null>;

  writeWorkspaceState(state: WorkspaceDomainState): Promise<void>;

  loadProjcache(): Promise<StoredProjcacheEntry[]>;

  /** 不经 await、直接读的路径（供同步的 `cachedSnapshot` 消费）；宿主提供不了则缺省。 */
  readProjcacheDirect?(sessionId: string): StoredProjcacheEntry | undefined;

  readSessionTitleDirect?(sessionId: string): { title: string; seq: number } | undefined;

  putProjcache(sessionId: string, rows: ProjectionCheckpoint): Promise<void>;

  pruneStaleProjcache(): Promise<number>;
}
