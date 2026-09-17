import { StorageError } from "@deepseek-ai/dsh-storage";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from "@deepseek-ai/dsh-storage";
import type { StorageRepository, WorkspaceRecord, WorkspaceDomainState } from "./types.ts";

export const RDB_STORAGE_BACKEND = "rdb";

const WORKSPACE_UNIT = "workspace";
const WORKSPACE_TABLE = "workspaces";

export class RdbStorageBackend implements StorageBackend {
  readonly kv: KvFacet = { open: (descriptor) => this.openUnit(descriptor) };

  private readonly open = new Map<string, WorkspaceKvUnit>();
  private closed = false;

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

    if (descriptor.layout !== undefined && descriptor.layout !== "single") {
      throw new Error(
        `rdb storage backend serves only the 'single' layout (domain '${descriptor.name}' ` +
          `declares '${descriptor.layout}')`,
      );
    }
    if (this.open.has(descriptor.name)) {
      throw new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`);
    }

    const unit = new WorkspaceKvUnit(this.repository, descriptor);
    this.open.set(descriptor.name, unit);
    try {
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
    } catch (error) {
      this.open.delete(descriptor.name);
      throw error;
    }
    unit.onClose(() => {
      this.open.delete(descriptor.name);
    });
    return unit;
  }

  async close(): Promise<void> {
    this.closed = true;
    const units = [...this.open.values()];
    this.open.clear();
    await Promise.all(units.map((unit) => unit.close()));
  }
}

class WorkspaceKvUnit implements KvUnit {
  private closed = false;

  private readonly inflight = new Set<Promise<void>>();
  private onClosed: (() => void) | undefined;

  constructor(
    private readonly repository: StorageRepository,
    private readonly descriptor: KvUnitDescriptor,
  ) {}

  onClose(release: () => void): void {
    this.onClosed = release;
  }

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
    await this.track(this.repository.putWorkspace(key, workspaceRecordOf(value)));
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen();
    this.assertTable(table);
    await this.track(this.repository.deleteWorkspace(key));
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen();
    await this.track(this.repository.writeWorkspaceState(workspaceStateOf(value)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    while (this.inflight.size > 0) {
      await Promise.allSettled(this.inflight);
    }
    this.onClosed?.();
  }

  private async track(operation: Promise<unknown>): Promise<void> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(settled);
    try {
      await operation;
    } finally {
      this.inflight.delete(settled);
    }
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
