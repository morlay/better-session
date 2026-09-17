import type { TableDef } from "../../adapters/types.ts";

export const workspaces: TableDef = {
  name: "t_workspaces",
  columns: {
    f_id: { type: "serial", primaryKey: true },
    f_workspace_id: { type: "text", notNull: true, unique: true },
    f_path: { type: "text", notNull: true },
    f_title: { type: "text", notNull: true },
    f_created_at: { type: "text", notNull: true },
    f_updated_at: { type: "text", notNull: true },
    f_position: { type: "integer", notNull: true, default: -1 },
  },
};
