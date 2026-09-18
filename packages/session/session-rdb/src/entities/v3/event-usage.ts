import type { TableDef } from "../../adapters/types.ts";

/**
 * 用量日志：一条 `assistant/message` 事件一行（按事件行唯一，fork 共享行不重复）。
 * 统计只读这张表，不再逐行解析事件的 JSON；事件行本身仍留在 `t_events`。
 */
export const eventUsage: TableDef = {
  name: "t_event_usage",
  columns: {
    f_event_id: {
      type: "text",
      primaryKey: true,
      references: { table: "t_events", column: "f_event_id", onDelete: "cascade" },
    },
    f_created_at: { type: "integer", notNull: true },
    f_provider: { type: "text" },
    f_model: { type: "text" },
    f_input_tokens: { type: "integer", notNull: true },
    f_output_tokens: { type: "integer", notNull: true },
    f_cache_read_tokens: { type: "integer", notNull: true },
    f_reasoning_tokens: { type: "integer", notNull: true },
    f_total_tokens: { type: "integer", notNull: true },
  },
  indexes: { idx_event_usage_created_at: { columns: ["f_created_at"] } },
};
