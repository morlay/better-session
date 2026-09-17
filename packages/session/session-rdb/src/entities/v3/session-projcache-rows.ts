import type { TableDef } from "../../adapters/types.ts";

export const sessionProjcacheRows: TableDef = {
  name: "t_session_projcache_row",
  columns: {
    f_id: { type: "serial", primaryKey: true },
    f_session_id: {
      type: "text",
      notNull: true,
      references: { table: "t_sessions", column: "f_session_id", onDelete: "cascade" },
    },
    f_key: { type: "text", notNull: true },
    f_ver: { type: "integer", notNull: true },
    f_seq: { type: "integer", notNull: true },
    f_val: { type: "text", notNull: true },
  },
  uniques: { uq_session_projcache_row_session_key: { columns: ["f_session_id", "f_key"] } },
  indexes: { idx_session_projcache_row_key: { columns: ["f_key"] } },
};
