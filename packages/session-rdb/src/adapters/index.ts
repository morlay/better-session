/**
 * 方言适配层：把 `entities/` 的纯表描述转化为具体后端的 drizzle 表对象与
 * 建表 DDL。实体定义本身保持方言无关（见 `src/entities/`）。
 *
 * @module @morlay/session-rdb/adapters
 */

export { toSqliteSchema } from "./to-sqlite.ts";
export { toPostgresSchema } from "./to-postgres.ts";
export { createTableSql, createIndexSql, createTablesSql } from "./ddl.ts";
export type { Dialect } from "./ddl.ts";
