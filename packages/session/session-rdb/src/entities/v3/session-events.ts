import type { TableDef } from "../../adapters/types.ts";

export const sessionEvents: TableDef = {
  name: "t_session_events",
  columns: {
    f_id: { type: "serial", primaryKey: true },
    f_session_id: {
      type: "text",
      notNull: true,
      references: { table: "t_sessions", column: "f_session_id", onDelete: "cascade" },
    },
    f_event_id: {
      type: "text",
      notNull: true,
      references: { table: "t_events", column: "f_event_id", onDelete: "cascade" },
    },
    f_sequence: { type: "integer", notNull: true },
    f_surface_op: { type: "text" },
  },
  uniques: {
    uq_session_events_session_sequence: { columns: ["f_session_id", "f_sequence"] },
  },
  // UNIQUE(f_session_id, f_sequence) 自动建唯一索引（按 session 过滤 + seq
  // 范围/排序/取尾）；f_event_id 索引覆盖反向查找（孤儿事件行清理）。
  indexes: { idx_session_events_event_id: { columns: ["f_event_id"] } },
};
