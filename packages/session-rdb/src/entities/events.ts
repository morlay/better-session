import type { TableDef } from "./types.ts";

/**
 * `t_events` — 全局可寻址的持久化事件实体：`f_event_id`（UUID 唯一）、
 * `f_parent_id`（事件链，空串为 root）、`f_type`（= 上游 `type`）、
 * `f_kind`（事件种类：message/thinking/turn/tool/request/config/audit/
 * lifecycle/inbox/compaction/llm/subagent/team/workflow/goal/schedule/todo/
 * web）、`f_role`（对话角色：user/assistant/tool）、`f_name` / `f_action_id`
 * （事件名称 / 配对 id）、`f_encoding`（`json`）、`f_data`（JSON 文本，
 * **完整原始 data**——含 turn/step、shadowedRange 原始坐标，忠实存储，
 * 读取时按需 drop 或重映射）、`f_created_at`（= `time`）。
 *
 * 本表是**全局事件实体**，不含任何 session 专属信息：一个事件行可被多个
 * 会话的桥接行引用（fork 派生会话复用父会话事件行，不复制）。session 专属
 * 的 surface 元数据（`f_surface_op`）与上游 seq（`f_original_seq`）在
 * `t_session_events` 桥接行上；`sourceEventSeqs` 不落库——读取时对 replace
 * 事件按 surfaceOp range 重新计算（见 `log.ts` 的 `recomputeReplaceProvenance`）。
 */
export const events: TableDef = {
  name: "t_events",
  columns: [
    { name: "f_id", type: "serial", primaryKey: true },
    { name: "f_event_id", type: "text", notNull: true, unique: true },
    { name: "f_parent_id", type: "text", notNull: true, default: "" },
    { name: "f_type", type: "text", notNull: true, default: "" },
    { name: "f_kind", type: "text", notNull: true, default: "" },
    { name: "f_role", type: "text", notNull: true, default: "" },
    { name: "f_name", type: "text", notNull: true, default: "" },
    { name: "f_action_id", type: "text", notNull: true, default: "" },
    { name: "f_encoding", type: "text", notNull: true, default: "" },
    { name: "f_data", type: "text", notNull: true },
    { name: "f_created_at", type: "bigint", notNull: true, default: 0 },
  ],
  indexes: [
    { name: "idx_events_kind", columns: ["f_kind"] },
    { name: "idx_events_role", columns: ["f_role"] },
    { name: "idx_events_name", columns: ["f_name"] },
    { name: "idx_events_action_id", columns: ["f_action_id"] },
  ],
  // 查询只经 f_event_id（列级 UNIQUE 自动建唯一索引，join 查找侧）与
  // t_session_events 的复合索引（按 session 过滤后回表取本表列）。事件链
  // f_parent_id 仅在写路径构造（读时不回读该列）。维度列索引为审计/UI
  // 过滤预留（f_kind / f_role / f_name / f_action_id）。
};
