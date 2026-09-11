import type { TableDef } from "../../adapters/types.ts";

export const schemaMeta: TableDef = {
  name: "t_schema_meta",
  columns: {
    f_key: { type: "text", primaryKey: true },
    f_value: { type: "text", notNull: true },
  },
};
