import type { TableDef } from "../../adapters/types.ts";

/**
 * 投影 checkpoint 行（上游 checkpoint 的 `(sessionId, key, ver, seq, val)`
 * 逐行落库）：`f_seq` 是该行的日志水位、`f_ver` 是投影单元的 stateVersion。
 * 行是折出捷径、非权威，版本不匹配时整行丢弃。
 *
 * checkpoint 的日志 identity 不另存一份：它与 `t_sessions` 的行是 1:1，直接
 * 复用该行的 `f_version` / `f_created_at` / `f_cwd` / `f_seed_length` 做校验。
 */
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
