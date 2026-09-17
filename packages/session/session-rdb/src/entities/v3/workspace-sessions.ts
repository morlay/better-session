import type { TableDef } from "../../adapters/types.ts";

export const workspaceSessions: TableDef = {
  name: "t_workspace_sessions",
  columns: {
    f_id: { type: "serial", primaryKey: true },
    f_workspace_id: {
      type: "text",
      notNull: true,
      references: { table: "t_workspaces", column: "f_workspace_id", onDelete: "cascade" },
    },
    f_session_id: { type: "text", notNull: true },
    f_position: { type: "integer", notNull: true },
  },
  uniques: {
    uq_workspace_sessions_workspace_session: { columns: ["f_workspace_id", "f_session_id"] },
  },
  indexes: { idx_workspace_sessions_session_id: { columns: ["f_session_id"] } },
};
