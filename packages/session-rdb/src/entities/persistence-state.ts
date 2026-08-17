import type { TableDef } from "./types.ts";

/**
 * `t_persistence_state` — 单例 store 身份行。`f_singleton` 上的 CHECK 把表
 * 钉死为一行（`f_singleton = 1`）。
 */
export const persistenceState: TableDef = {
  name: "t_persistence_state",
  columns: [
    { name: "f_singleton", type: "integer", primaryKey: true },
    { name: "f_store_id", type: "text", notNull: true },
  ],
  checks: [{ name: "ck_persistence_state_singleton", expression: "f_singleton = 1" }],
};
