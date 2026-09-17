import type { TableDef } from "../../adapters/types.ts";

export const events: TableDef = {
  name: "t_events",
  columns: {
    f_id: { type: "serial", primaryKey: true },
    f_event_id: { type: "text", notNull: true, unique: true },
    f_parent_id: { type: "text", notNull: true, default: "" },
    f_type: { type: "text", notNull: true, default: "" },
    f_kind: { type: "text", notNull: true, default: "" },
    f_role: { type: "text", notNull: true, default: "" },
    f_name: { type: "text", notNull: true, default: "" },
    f_action_id: { type: "text", notNull: true, default: "" },
    f_encoding: { type: "text", notNull: true, default: "" },
    f_data: { type: "text", notNull: true },
    f_created_at: { type: "bigint", notNull: true, default: 0 },
  },

  indexes: {
    idx_events_kind: { columns: ["f_kind"] },
    idx_events_role: { columns: ["f_role"] },
    idx_events_name: { columns: ["f_name"] },
    idx_events_action_id: { columns: ["f_action_id"] },
  },
};
