/**
 * storages 接管：注册在 storage hub 上的 `rdb` KV 后端。它把 workspace 域
 * （上游 single 布局：一张 `workspaces` 表 + global 单例）映射到 session-rdb
 * 的语义专用表，与事件日志同库同连接；域层（`ctx.storageDomain`）通过
 * `routes` 把 `workspace` 域路由到本后端。
 *
 * 本后端只服务已知域的专用表：未知 unit 名 fail loud，而不是静默落到通用
 * 存储——表结构是显式维护的（见 docs/schema.md）。
 */

import { StorageError } from "@deepseek-ai/dsh-storage";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from "@deepseek-ai/dsh-storage";
import type { StorageRepository, WorkspaceRecord, WorkspaceDomainState } from "./types.ts";

/** 注册到 storage hub 的后端名（storage-domain 的 routes 引用它）。 */
export const RDB_STORAGE_BACKEND = "rdb";

/** 本后端唯一服务的域：上游 `workspaceDomainSpec`（v2，single 布局）。 */
const WORKSPACE_UNIT = "workspace";
const WORKSPACE_TABLE = "workspaces";

/** 只服务 workspace 域的 KV 后端。 */
export class RdbStorageBackend implements StorageBackend {
  readonly kv: KvFacet = { open: (descriptor) => this.openUnit(descriptor) };

  /** 已打开（或打开中）的 unit 名；重复 open 是调用方 bug。 */
  private readonly open = new Set<string>();
  private closed = false;

  /**
   * @param repository - storages 接管表访问层（与事件日志同介质）。
   */
  constructor(private readonly repository: StorageRepository) {}

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closed) throw new StorageError("closed", "rdb storage backend is closed");
    if (descriptor.name !== WORKSPACE_UNIT) {
      throw new Error(
        `rdb storage backend serves only the '${WORKSPACE_UNIT}' domain (requested '${descriptor.name}')`,
      );
    }
    if (!descriptor.tables.includes(WORKSPACE_TABLE) || descriptor.hasGlobal !== true) {
      throw new Error(
        `rdb storage backend expects the '${WORKSPACE_UNIT}' domain shape ` +
          `(table '${WORKSPACE_TABLE}' plus a global slot)`,
      );
    }
    if (this.open.has(descriptor.name)) {
      throw new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`);
    }
    const stored = await this.repository.readUnitVersion(descriptor.name);
    if (stored === undefined) {
      await this.repository.insertUnitVersion(descriptor.name, descriptor.version);
    } else if (stored !== descriptor.version) {
      throw new StorageError(
        "version-mismatch",
        `kv unit '${descriptor.name}' is stamped version ${stored} on the medium, ` +
          `incompatible with descriptor version ${descriptor.version}`,
      );
    }
    this.open.add(descriptor.name);
    return new WorkspaceKvUnit(this.repository, descriptor, () => {
      this.open.delete(descriptor.name);
    });
  }

  /**
   * Release the backend. The medium (the session database) belongs to the
   * owning session-rdb plugin, so closing open units here does not close it.
   * @returns resolution after the name table is cleared.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.open.clear();
  }
}

/** workspace 域的 KV unit：每个原语一条 SQL 语句，值形状与上游记录一致。 */
class WorkspaceKvUnit implements KvUnit {
  private closed = false;

  constructor(
    private readonly repository: StorageRepository,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {}

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen();
    const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const { id, record } of await this.repository.listWorkspaces()) {
      records[id] = record;
    }
    const state = await this.repository.readWorkspaceState();
    return { tables: { [WORKSPACE_TABLE]: records }, global: state };
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen();
    this.assertTable(table);
    await this.repository.putWorkspace(key, workspaceRecordOf(value));
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen();
    this.assertTable(table);
    await this.repository.deleteWorkspace(key);
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen();
    await this.repository.writeWorkspaceState(workspaceStateOf(value));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError("closed", `kv unit '${this.descriptor.name}' is closed`);
    }
  }

  private assertTable(table: string): void {
    if (table !== WORKSPACE_TABLE) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`);
    }
  }
}

/** Narrow one opaque KV record to the workspace record the domain shipped. */
function workspaceRecordOf(value: unknown): WorkspaceRecord {
  const record = value as Partial<WorkspaceRecord> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.path !== "string" ||
    typeof record.title !== "string" ||
    !Array.isArray(record.sessionIds) ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    throw new TypeError("workspace record does not match the stored shape");
  }
  return {
    path: record.path,
    title: record.title,
    sessionIds: record.sessionIds.map((id) => id as SessionId),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Narrow one opaque KV global to the workspace registry state the domain shipped. */
function workspaceStateOf(value: unknown): WorkspaceDomainState {
  const state = value as Partial<WorkspaceDomainState> | null;
  if (
    typeof state !== "object" ||
    state === null ||
    typeof state.initialized !== "boolean" ||
    !Array.isArray(state.workspaceIds) ||
    !Array.isArray(state.archivedSessionIds)
  ) {
    throw new TypeError("workspace registry state does not match the stored shape");
  }
  return {
    initialized: state.initialized,
    workspaceIds: state.workspaceIds.map((id) => id as WorkspaceId),
    archivedSessionIds: state.archivedSessionIds.map((id) => id as SessionId),
    ...(state.pendingMutation === undefined ? {} : { pendingMutation: state.pendingMutation }),
  };
}
