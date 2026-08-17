import type { TableDef } from "./types.ts";

/**
 * `t_sessions` — 会话元数据（`SessionHeader` 列）+ playpen 风格 head 游标
 * （`f_head_event_id` / `f_head_sequence`，事务内维护，append 时提供 parent
 * 链与下一个 seq）。行的存在即 materialized 信号。
 */
export const sessions: TableDef = {
  name: "t_sessions",
  columns: [
    { name: "f_id", type: "serial", primaryKey: true },
    { name: "f_session_id", type: "text", notNull: true, unique: true },
    { name: "f_head_event_id", type: "text", notNull: true, default: "" },
    { name: "f_head_sequence", type: "integer", notNull: true, default: -1 },
    { name: "f_version", type: "integer", notNull: true },
    { name: "f_created_at", type: "bigint", notNull: true },
    { name: "f_cwd", type: "text" },
    { name: "f_parent_session", type: "text" },
    { name: "f_seed_length", type: "integer" },
    { name: "f_origin", type: "text" },
    { name: "f_delegation_depth", type: "integer" },
    { name: "f_incarnation", type: "text", notNull: true },
    { name: "f_revision", type: "integer", notNull: true },
  ],
};
