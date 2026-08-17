import type { TableDef } from "./types.ts";

/**
 * `t_events` — 全局可寻址的持久化事件实体：`f_event_id`（UUID 唯一）、
 * `f_parent_id`（事件链，空串为 root）、`f_kind`（= 上游 `type`）、
 * `f_role` / `f_name` / `f_action_id`（playpen 事件维度）、`f_encoding`
 * （`json`）、`f_data`（JSON 文本）、`f_created_at`（= `time`）、
 * `f_original_seq`（上游 seq）以及 surface 元数据列（JSON 文本或 NULL）。
 */
export const events: TableDef = {
  name: "t_events",
  columns: [
    { name: "f_id", type: "serial", primaryKey: true },
    { name: "f_event_id", type: "text", notNull: true, unique: true },
    { name: "f_parent_id", type: "text", notNull: true, default: "" },
    { name: "f_kind", type: "text", notNull: true, default: "" },
    { name: "f_role", type: "text", notNull: true, default: "" },
    { name: "f_name", type: "text", notNull: true, default: "" },
    { name: "f_action_id", type: "text", notNull: true, default: "" },
    { name: "f_encoding", type: "text", notNull: true, default: "" },
    { name: "f_data", type: "text", notNull: true },
    { name: "f_created_at", type: "bigint", notNull: true, default: 0 },
    { name: "f_original_seq", type: "integer", notNull: true },
    { name: "f_source_event_seqs", type: "text" },
    { name: "f_surface_op", type: "text" },
  ],
  // 无独立索引：查询只经 `f_event_id`（列级 UNIQUE 自动建唯一索引，join 查找侧）
  // 与 `t_session_events` 的复合索引（按 session 过滤后回表取本表列）。事件链
  // `f_parent_id` 仅在写路径构造（读时不回读该列），无按 kind/role/created_at
  // 的查询——不再为不可达查询维护索引（写放大）。
};
