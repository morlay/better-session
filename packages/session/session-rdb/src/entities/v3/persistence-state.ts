import type { TableDef } from "../../adapters/types.ts";

export const persistenceState: TableDef = {
  name: "t_persistence_state",
  columns: {
    f_singleton: { type: "integer", primaryKey: true },
    f_store_id: { type: "text", notNull: true },
  },
  checks: { ck_persistence_state_singleton: { expression: "f_singleton = 1" } },
};
