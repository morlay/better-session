import type { TableDef } from "./types.ts";

/**
 * `t_session_events` — 会话↔事件桥接表。`(f_session_id, f_sequence)` 唯一且
 * 有序，会话 log 按稠密 seq 读取；删除 torn tail 只删桥接行（事件实体作为
 * 全局行保留）。
 */
export const sessionEvents: TableDef = {
  name: "t_session_events",
  columns: [
    { name: "f_id", type: "serial", primaryKey: true },
    {
      name: "f_session_id",
      type: "text",
      notNull: true,
      references: { table: "t_sessions", column: "f_session_id", onDelete: "cascade" },
    },
    {
      name: "f_event_id",
      type: "text",
      notNull: true,
      references: { table: "t_events", column: "f_event_id", onDelete: "cascade" },
    },
    { name: "f_sequence", type: "integer", notNull: true },
  ],
  uniques: [
    { name: "uq_session_events_session_sequence", columns: ["f_session_id", "f_sequence"] },
  ],
  // 不另建普通索引：`UNIQUE(f_session_id, f_sequence)` 约束自动创建的唯一索引
  // 已覆盖本表的全部访问模式（按 session 过滤 + 按 seq 范围/排序/取尾）。
};
