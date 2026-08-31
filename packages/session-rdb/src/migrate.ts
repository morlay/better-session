/**
 * SQLite v1 → v2 表结构迁移（启动时自动执行 + 手动脚本共用）。
 *
 * v1 表结构（旧坐标模型）：
 * - `t_events`：`f_kind`（= 上游 type）、`f_original_seq`、`f_source_event_seqs`、
 *   `f_surface_op`（上游坐标 provenance 落库）；
 * - `t_session_events`：`(f_session_id, f_event_id, f_sequence)`。
 *
 * v2 表结构（新坐标模型）：
 * - `t_events`：`f_type`（上游 type）+ `f_kind`（事件种类）+ `f_role` +
 *   `f_name` + `f_action_id`，无 `f_original_seq` / `f_source_event_seqs` /
 *   `f_surface_op`；
 * - `t_session_events`：`(f_session_id, f_event_id, f_sequence, f_original_seq,
 *   f_surface_op)`。
 *
 * 迁移（裸 SQL 事务内，最小变更）：
 * 1. 建 v2 表（临时名）；
 * 2. 逐行搬运 `t_events`：`f_type` = 旧 `f_kind`，`f_kind`/`f_role`/`f_name`/
 *    `f_action_id` 经 `eventDimensions` 重算（解析 `f_data`），`f_data` /
 *    `f_created_at` 原样；
 * 3. 逐行搬运 `t_session_events`：`f_original_seq` / `f_surface_op` 从旧
 *    `t_events` 对应行取（按 `f_event_id` join）；
 * 4. 删旧表、重命名新表；
 * 5. `user_version` = 2。
 *
 * @module @morlay/session-rdb/migrate
 */

import { DatabaseSync } from "node:sqlite";
import { eventDimensions } from "./schema.ts";

/** v2 schema 版本（与 `SCHEMA_VERSION` 一致；此处避免循环依赖）。 */
export const SCHEMA_VERSION_V2 = 2;

/**
 * 迁移一个 v1 SQLite 数据库到 v2。调用方负责持有写锁（启动初始化事务 /
 * 手动脚本的 BEGIN IMMEDIATE 内）。
 * @param db - 打开的 SQLite 连接（v1 库）。
 * @returns 迁移的事件数；库已是 v2 时返回 0（no-op）。
 * @throws 库版本不是 1 或 2、或数据损坏时抛错（事务由调用方回滚）。
 */
export function migrateSqliteV1ToV2(db: DatabaseSync): number {
  const { user_version: onDisk } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (onDisk === SCHEMA_VERSION_V2) return 0;
  if (onDisk !== 1) {
    throw new Error(`unsupported schema version ${onDisk} (expected 1)`);
  }

  // 1. 建 v2 表（临时名）。
  db.exec(`
    CREATE TABLE t_events_v2 (
      f_id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_event_id TEXT NOT NULL UNIQUE,
      f_parent_id TEXT NOT NULL DEFAULT '',
      f_type TEXT NOT NULL DEFAULT '',
      f_kind TEXT NOT NULL DEFAULT '',
      f_role TEXT NOT NULL DEFAULT '',
      f_name TEXT NOT NULL DEFAULT '',
      f_action_id TEXT NOT NULL DEFAULT '',
      f_encoding TEXT NOT NULL DEFAULT '',
      f_data TEXT NOT NULL,
      f_created_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE t_session_events_v2 (
      f_id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_session_id TEXT NOT NULL REFERENCES t_sessions(f_session_id) ON DELETE CASCADE,
      f_event_id TEXT NOT NULL REFERENCES t_events_v2(f_event_id) ON DELETE CASCADE,
      f_sequence INTEGER NOT NULL,
      f_original_seq INTEGER NOT NULL,
      f_surface_op TEXT,
      UNIQUE (f_session_id, f_sequence)
    ) STRICT;
    CREATE INDEX idx_events_v2_kind ON t_events_v2(f_kind);
    CREATE INDEX idx_events_v2_role ON t_events_v2(f_role);
    CREATE INDEX idx_events_v2_name ON t_events_v2(f_name);
    CREATE INDEX idx_events_v2_action_id ON t_events_v2(f_action_id);
    CREATE INDEX idx_session_events_v2_event_id ON t_session_events_v2(f_event_id);
  `);

  // 2. 搬运 t_events：f_type = 旧 f_kind，维度列重算。
  const oldEvents = db
    .prepare(
      `SELECT f_event_id, f_parent_id, f_kind, f_data, f_created_at FROM t_events ORDER BY f_id`,
    )
    .all() as Array<{
    f_event_id: string;
    f_parent_id: string;
    f_kind: string;
    f_data: string;
    f_created_at: number;
  }>;
  const insertEvent = db.prepare(`
    INSERT INTO t_events_v2
      (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding, f_data, f_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'json', ?, ?)
  `);
  for (const row of oldEvents) {
    let data: unknown;
    try {
      data = JSON.parse(row.f_data);
    } catch {
      throw new Error(`t_events row ${row.f_event_id} has unparsable f_data; aborting`);
    }
    const dims = eventDimensions({
      type: row.f_kind,
      seq: 0,
      time: row.f_created_at,
      data,
    } as never);
    insertEvent.run(
      row.f_event_id,
      row.f_parent_id,
      row.f_kind,
      dims.kind,
      dims.role,
      dims.name,
      dims.actionId,
      row.f_data,
      row.f_created_at,
    );
  }

  // 3. 搬运 t_session_events：f_original_seq / f_surface_op 从旧 t_events 取。
  const oldBridges = db
    .prepare(
      `SELECT se.f_session_id, se.f_event_id, se.f_sequence
       FROM t_session_events se ORDER BY se.f_id`,
    )
    .all() as Array<{ f_session_id: string; f_event_id: string; f_sequence: number }>;
  const oldEventMeta = new Map(
    (
      db
        .prepare(
          `SELECT f_event_id, f_original_seq, f_surface_op FROM t_events`,
        )
        .all() as Array<{
        f_event_id: string;
        f_original_seq: number;
        f_surface_op: string | null;
      }>
    ).map((row) => [row.f_event_id, row]),
  );
  const insertBridge = db.prepare(`
    INSERT INTO t_session_events_v2
      (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of oldBridges) {
    const meta = oldEventMeta.get(row.f_event_id);
    if (meta === undefined) {
      throw new Error(
        `bridge row ${row.f_session_id}:${row.f_sequence} references missing event ${row.f_event_id}`,
      );
    }
    insertBridge.run(
      row.f_session_id,
      row.f_event_id,
      row.f_sequence,
      meta.f_original_seq,
      meta.f_surface_op,
    );
  }

  // 4. 删旧表、重命名新表。
  db.exec(`
    DROP TABLE t_session_events;
    DROP TABLE t_events;
    ALTER TABLE t_events_v2 RENAME TO t_events;
    ALTER TABLE t_session_events_v2 RENAME TO t_session_events;
  `);

  // 5. user_version = 2。
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_V2}`);
  return oldEvents.length;
}
