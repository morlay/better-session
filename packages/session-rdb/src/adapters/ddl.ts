/**
 * 从方言无关的表描述生成建表 DDL（`CREATE TABLE IF NOT EXISTS` 与独立索引）。
 * SQLite 表附带 `STRICT`，PostgreSQL 用 `SERIAL` / `BIGINT` 等方言类型。
 * 这是实体的唯一 DDL 来源——不手写 SQL 字符串。
 *
 * @module @morlay/session-rdb/entities/ddl
 */

import type { ColumnDef, TableDef } from "../entities/types.ts";

export type Dialect = "sqlite" | "postgres";

function sqlType(dialect: Dialect, type: ColumnDef["type"]): string {
  switch (type) {
    case "serial":
      return dialect === "sqlite" ? "INTEGER" : "SERIAL";
    case "integer":
      return "INTEGER";
    case "bigint":
      return dialect === "sqlite" ? "INTEGER" : "BIGINT";
    case "text":
      return "TEXT";
  }
}

function literal(value: string | number): string {
  return typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);
}

function quote(name: string): string {
  return `"${name}"`;
}

function columnSql(dialect: Dialect, c: ColumnDef): string {
  let sql = `${quote(c.name)} ${sqlType(dialect, c.type)}`;
  if (c.primaryKey) sql += " PRIMARY KEY";
  if (c.type === "serial" && dialect === "sqlite") sql += " AUTOINCREMENT";
  if (c.notNull) sql += " NOT NULL";
  if (c.default !== undefined) sql += ` DEFAULT ${literal(c.default)}`;
  if (c.unique) sql += " UNIQUE";
  if (c.references) {
    sql += ` REFERENCES ${quote(c.references.table)}(${quote(c.references.column)})`;
    if (c.references.onDelete) sql += ` ON DELETE ${c.references.onDelete.toUpperCase()}`;
  }
  return sql;
}

/** 一张表的 `CREATE TABLE IF NOT EXISTS`（表级约束内联在列清单末尾）。 */
export function createTableSql(dialect: Dialect, def: TableDef): string {
  const parts = def.columns.map((c) => columnSql(dialect, c));
  for (const ck of def.checks ?? []) parts.push(`CHECK (${ck.expression})`);
  for (const u of def.uniques ?? []) {
    parts.push(`UNIQUE (${u.columns.map(quote).join(", ")})`);
  }
  const strict = dialect === "sqlite" ? " STRICT" : "";
  return `CREATE TABLE IF NOT EXISTS ${quote(def.name)} (\n  ${parts.join(",\n  ")}\n)${strict}`;
}

/** 一张表的独立索引语句（两方言索引 DDL 相同，无需 dialect 参数）。 */
export function createIndexSql(def: TableDef, name: string): string {
  const idx = def.indexes?.find((i) => i.name === name);
  if (idx === undefined) throw new Error(`unknown index "${name}" on table "${def.name}"`);
  return `CREATE INDEX IF NOT EXISTS ${quote(idx.name)} ON ${quote(def.name)}(${idx.columns
    .map(quote)
    .join(", ")})`;
}

/** 一组表的全部建表语句（每表一条 CREATE TABLE + 每条索引）。 */
export function createTablesSql(dialect: Dialect, defs: readonly TableDef[]): string[] {
  const statements: string[] = [];
  for (const def of defs) {
    statements.push(createTableSql(dialect, def));
    for (const idx of def.indexes ?? []) statements.push(createIndexSql(def, idx.name));
  }
  return statements;
}
