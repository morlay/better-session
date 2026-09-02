import type { TableDef } from "./types.ts";

export const persistenceState: TableDef = {
  name: "t_persistence_state",
  columns: [
    { name: "f_singleton", type: "integer", primaryKey: true },
    { name: "f_store_id", type: "text", notNull: true },
  ],
  checks: [{ name: "ck_persistence_state_singleton", expression: "f_singleton = 1" }],
};
