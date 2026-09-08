import type { TableDef } from "../../adapters/types.ts";

export const sessions: TableDef = {
  name: "t_sessions",
  columns: {
    f_id: { type: "serial", primaryKey: true },
    f_session_id: { type: "text", notNull: true, unique: true },
    f_head_event_id: { type: "text", notNull: true, default: "" },
    f_head_sequence: { type: "integer", notNull: true, default: -1 },
    f_version: { type: "integer", notNull: true },
    f_created_at: { type: "bigint", notNull: true },
    f_cwd: { type: "text" },
    f_parent_session: { type: "text" },
    f_seed_length: { type: "integer" },
    f_origin: { type: "text" },
    f_delegation_depth: { type: "integer" },
    f_incarnation: { type: "text", notNull: true },
    f_revision: { type: "integer", notNull: true },
  },
};
