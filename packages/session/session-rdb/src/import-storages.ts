/**
 * 一次性导入：把旧 `$DSH_HOME/storages` 的 JSON 数据搬进 session-rdb 的
 * 语义专用表（显式命令触发，不做启动隐式导入）。旧文件保留不删，便于对账与
 * 回退。
 *
 * 支持两种来源布局：
 * - `workspace.json`：single 文档（`{unit, global, tables}`）；
 * - `session_projcache/sessions/*.json`：v7 per-record 文档；目录缺失时回退
 *   读旧 single 文档 `session_projcache.json`。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProjectionCheckpoint,
  StorageRepository,
  WorkspaceDomainState,
  WorkspaceRecord,
} from "./storage-takeover/types.ts";
import { SessionId } from "@deepseek-ai/dsh-session";

/** 一条待导入的投影 checkpoint：identity 不落库（复用会话行），只导行。 */
interface ImportedProjcache {
  sessionId: SessionId;
  rows: ProjectionCheckpoint;
}

/** 导入统计（按记录数）。 */
export interface StoragesImportResult {
  /** 导入的 workspace 记录数。 */
  workspaces: number;
  /** 是否导入了 workspace global 单例。 */
  workspaceState: boolean;
  /** 导入的投影 checkpoint 记录数。 */
  projcache: number;
}

/** 导入参数。 */
export interface StoragesImportOptions {
  /** Harness home（含 `storages/` 的目录）。 */
  dshHome: string;
}

const WORKSPACE_UNIT = "workspace";
const WORKSPACE_UNIT_VERSIONS = new Set([2]);
const PROJCACHE_UNIT = "session_projcache";
const PROJCACHE_UNIT_VERSIONS = new Set([7, 3, 4, 5, 6]);

/**
 * Import the legacy storages documents into the rdb tables.
 * @param repository - storages takeover access layer (medium already open).
 * @param options - harness home holding the legacy `storages/` tree.
 * @returns per-record import counts.
 */
export async function importStorages(
  repository: StorageRepository,
  options: StoragesImportOptions,
): Promise<StoragesImportResult> {
  const storagesRoot = join(options.dshHome, "storages");
  const result: StoragesImportResult = { workspaces: 0, workspaceState: false, projcache: 0 };

  const workspaceDocument = await readJson(join(storagesRoot, `${WORKSPACE_UNIT}.json`));
  if (workspaceDocument !== undefined) {
    const tables = unitTables(workspaceDocument, WORKSPACE_UNIT, WORKSPACE_UNIT_VERSIONS);
    await repository.insertUnitVersion(
      WORKSPACE_UNIT,
      WORKSPACE_UNIT_VERSIONS.values().next().value as number,
    );
    for (const [id, record] of Object.entries(tables["workspaces"] ?? {})) {
      await repository.putWorkspace(id, record as WorkspaceRecord);
      result.workspaces += 1;
    }
    if (workspaceDocument.global !== undefined && workspaceDocument.global !== null) {
      await repository.writeWorkspaceState(workspaceDocument.global as WorkspaceDomainState);
      result.workspaceState = true;
    }
  }

  const projcacheEntries = await readProjcacheEntries(storagesRoot);
  if (projcacheEntries.length > 0) {
    await repository.insertUnitVersion(
      PROJCACHE_UNIT,
      PROJCACHE_UNIT_VERSIONS.values().next().value as number,
    );
    for (const entry of projcacheEntries) {
      // 只导行：checkpoint 的 identity 由 t_sessions 的行承载（会话不存在时
      // 外键拒绝写入，导入 fail loud）。
      await repository.putProjcache(entry.sessionId, entry.rows);
      result.projcache += 1;
    }
  }

  return result;
}

/** Read one JSON document; a missing file is `undefined`, malformed JSON fails loud. */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Validate one legacy single document's unit identity and return its tables map. */
function unitTables(
  document: Record<string, unknown>,
  name: string,
  versions: ReadonlySet<number>,
): Record<string, Record<string, unknown>> {
  const unit = document["unit"] as { name?: unknown; version?: unknown } | undefined;
  if (unit?.name !== name) {
    throw new Error(`storages document is not the '${name}' unit`);
  }
  if (typeof unit.version !== "number" || !versions.has(unit.version)) {
    throw new Error(
      `storages document '${name}' is stamped version ${String(unit.version)}, not in the accepted set`,
    );
  }
  const tables = document["tables"];
  if (typeof tables !== "object" || tables === null) {
    throw new Error(`storages document '${name}' has no tables object`);
  }
  return tables as Record<string, Record<string, unknown>>;
}

/**
 * Read projection checkpoints from the per-record directory, falling back to
 * the legacy whole-unit document when the directory is absent.
 */
async function readProjcacheEntries(storagesRoot: string): Promise<ImportedProjcache[]> {
  const entries: ImportedProjcache[] = [];
  const sessionsDir = join(storagesRoot, PROJCACHE_UNIT, "sessions");
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readLegacyProjcache(join(storagesRoot, `${PROJCACHE_UNIT}.json`));
  }
  for (const file of files) {
    const document = (await readJson(join(sessionsDir, file))) as
      | { version?: unknown; record?: unknown }
      | undefined;
    if (document === undefined) continue;
    if (typeof document.version !== "number" || !PROJCACHE_UNIT_VERSIONS.has(document.version)) {
      // Stale per-record document: the cache reads it as absent, so the import
      // discards it too instead of stamping it current.
      continue;
    }
    const record = document.record as { identity?: unknown; rows?: unknown } | undefined;
    if (record === undefined || typeof record !== "object") continue;
    entries.push({
      sessionId: SessionId(file.slice(0, -".json".length)),
      rows: (record.rows ?? {}) as ProjectionCheckpoint,
    });
  }
  return entries;
}

/** Read the legacy whole-unit projection cache document (`{unit, tables:{sessions}}`). */
async function readLegacyProjcache(path: string): Promise<ImportedProjcache[]> {
  const document = await readJson(path);
  if (document === undefined) return [];
  const tables = unitTables(document, PROJCACHE_UNIT, PROJCACHE_UNIT_VERSIONS);
  return Object.entries(tables["sessions"] ?? {}).map(([sessionId, record]) => {
    const value = record as { rows?: unknown };
    return {
      sessionId: SessionId(sessionId),
      rows: (value.rows ?? {}) as ProjectionCheckpoint,
    };
  });
}
