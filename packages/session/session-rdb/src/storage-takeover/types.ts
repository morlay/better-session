/**
 * storages 接管的类型：**能复用上游契约的一律复用**——记录形状来自上游
 * domain/projection 的 `z.infer` 产物（`WorkspaceRecord` / `WorkspaceDomainState`
 * / `CheckpointIdentity` / `ProjectionCheckpoint`），本文件只声明存储层的访问
 * 接口与"上游类型 + 会话键"的组合。上游 spec 变化时这里直接编译报错，不会
 * 静默偏移。
 *
 * 这些 import 全是类型导入（无运行时依赖）：rdb 是通用插件，不能硬依赖
 * web 层的 workspace 包或已被替换的 projcache 包。
 */

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

/**
 * 一个会话的完整 checkpoint：上游 `CheckpointIdentity`（日志身份，唯一权威定义
 * 在被替换的 projcache spec 里）+ 上游 `ProjectionCheckpoint`（逐 key 行）+ 会话键。
 */
export interface StoredProjcacheEntry {
  sessionId: SessionId;
  identity: CheckpointIdentity;
  rows: ProjectionCheckpoint;
}

/**
 * storages 接管表的方言无关访问层：SQLite 与 PostgreSQL 两个 Backend 各提供
 * 同一实现，调用方（KV 后端与投影缓存服务）不感知介质差异。读方法返回持久
 * 值的语义视图，workspace 的写入在介质事务内整体替换。
 */
export interface StorageRepository {
  /** 读一个域的版本戳；域从未打开时 undefined。 */
  readUnitVersion(name: string): Promise<number | undefined>;
  /** 写入域的首次版本戳；已存在时保持原值。 */
  insertUnitVersion(name: string, version: number): Promise<void>;
  /** 读全部 workspace 记录（按 workspace id）。 */
  listWorkspaces(): Promise<Array<{ id: string; record: WorkspaceRecord }>>;
  /** 覆盖写一条 workspace 记录（含归属行）。 */
  putWorkspace(id: string, record: WorkspaceRecord): Promise<void>;
  /** 删除一条 workspace 记录（缺失为 no-op）。 */
  deleteWorkspace(id: string): Promise<void>;
  /** 读 workspace 单例；从未写入时 null。 */
  readWorkspaceState(): Promise<WorkspaceDomainState | null>;
  /** 覆盖写 workspace 单例（显示顺序与归档集一并整体替换）。 */
  writeWorkspaceState(state: WorkspaceDomainState): Promise<void>;
  /** 读全部投影 checkpoint（含逐 key 行）。 */
  loadProjcache(): Promise<StoredProjcacheEntry[]>;
  /**
   * 同步读一个会话的 checkpoint：只有同步驱动（SQLite）提供，读路径直接落到
   * 介质；异步驱动（PostgreSQL）缺席，调用方退化为写穿镜像。上游的
   * `cachedSnapshot` 系列是同步签名，这里的存在性就是"能否直读库"的开关。
   * @param sessionId - 会话 id。
   * @returns 该会话的 checkpoint，缺失时 `undefined`。
   */
  readProjcacheSync?(sessionId: string): StoredProjcacheEntry | undefined;
  /**
   * 同步读一个会话的标题列（`t_sessions.f_title` / `f_title_seq`，rdb 写路径与
   * rewind 维护）：只有同步驱动提供，列表消费直接取会话数据，不依赖 checkpoint
   * 行是否存在。
   * @param sessionId - 会话 id。
   * @returns 标题与其事件 seq，未写过标题时 `undefined`。
   */
  readSessionTitleSync?(sessionId: string): { title: string; seq: number } | undefined;
  /**
   * 覆盖写一个会话的 checkpoint 行（先清旧行再写新行，同一事务）。记录头
   * 不在这里：它与 `t_sessions` 行 1:1，identity 直接复用该行的列。
   * @param sessionId - 会话 id。
   * @param rows - 每个投影 key 一行。
   */
  putProjcache(sessionId: string, rows: ProjectionCheckpoint): Promise<void>;
  /** 删除一个会话的 checkpoint（缺失为 no-op）。 */
  deleteProjcache(sessionId: string): Promise<void>;
}
