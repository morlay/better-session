import type { TableDef } from "./types.ts";

export const schemaMeta: TableDef = {
  name: "t_schema_meta",
  columns: [
    { name: "f_key", type: "text", primaryKey: true },
    { name: "f_value", type: "text", notNull: true },
  ],
};
