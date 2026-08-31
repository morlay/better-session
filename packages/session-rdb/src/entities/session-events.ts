import type { TableDef } from "./types.ts";

/**
 * `t_session_events` — 会话↔事件桥接表。`(f_session_id, f_sequence)` 唯一且
 * 有序，会话 log 按稠密 seq 读取；删除 torn tail / rewind 只删桥接行（事件
 * 实体作为全局行保留，可被多会话引用）。
 *
 * session 专属信息全部在本表：`f_sequence`（稠密持久化 seq）、
 * `f_original_seq`（上游 seq，重映射查阅）、`f_surface_op`（surface 元数据，
 * 原始坐标——replace 的 range 是上游 seq，读取时重映射）。
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
    { name: "f_original_seq", type: "integer", notNull: true },
    { name: "f_surface_op", type: "text" },
  ],
  uniques: [
    { name: "uq_session_events_session_sequence", columns: ["f_session_id", "f_sequence"] },
  ],
  indexes: [{ name: "idx_session_events_event_id", columns: ["f_event_id"] }],
  // `UNIQUE(f_session_id, f_sequence)` 约束自动创建的唯一索引已覆盖按 session
  // 过滤 + 按 seq 范围/排序/取尾；f_event_id 索引覆盖反向查找（按事件找会话、
  // 孤儿事件行清理）。
};
