import type { TableDef } from "../../adapters/types.ts";

export const workspaceState: TableDef = {
  name: "t_workspace_state",
  columns: {
    f_singleton: { type: "integer", primaryKey: true },
    f_initialized: { type: "integer", notNull: true },
    f_pending_operation: { type: "text" },
    f_pending_workspace_id: { type: "text" },
  },
  checks: { ck_workspace_state_singleton: { expression: "f_singleton = 1" } },
};
