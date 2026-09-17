import type { TableDef } from "../../adapters/types.ts";

export const storageUnits: TableDef = {
  name: "t_storage_units",
  columns: {
    f_name: { type: "text", primaryKey: true },
    f_version: { type: "integer", notNull: true },
  },
};
