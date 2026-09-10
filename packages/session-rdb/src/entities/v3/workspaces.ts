import type { TableDef } from "../../adapters/types.ts";

/**
 * workspace 域记录表（上游 `workspace` 域 v2 的 `workspaces` 表）：
 * 记录本身拆成语义列；会话归属在 {@link workspaceSessions}（带顺序），
 * 显示顺序由 `f_position` 承载（未进入 `workspaceIds` 的记录为 -1）。
 */
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
