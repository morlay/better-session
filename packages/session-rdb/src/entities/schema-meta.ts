import type { TableDef } from "./types.ts";

/**
 * `t_schema_meta` — PostgreSQL 的 schema 版本 / 应用身份载体（SQLite 用
 * `PRAGMA user_version` / `application_id`，PG 无等价 pragma）。键值表：
 * `schema_version` 与 `application_id` 两行在首次初始化时写入。
 * 仅 PostgreSQL 后端使用。
 */
export const schemaMeta: TableDef = {
  name: "t_schema_meta",
  columns: [
    { name: "f_key", type: "text", primaryKey: true },
    { name: "f_value", type: "text", notNull: true },
  ],
};
