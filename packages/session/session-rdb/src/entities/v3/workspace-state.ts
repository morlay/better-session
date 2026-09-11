import type { TableDef } from "../../adapters/types.ts";

/**
 * workspace 域 global 单例（上游 `workspaceDomainState`）：`initialized` 是
 * 引导标记，`pendingMutation` 拆成操作与目标两列（create / delete 的可恢复
 * 两写标记）。显示顺序（`workspaceIds`）在 `t_workspaces.f_position`，
 * 归档集在 `t_session_archives`。
 */
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
