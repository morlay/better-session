/**
 * 从方言无关的表描述生成 PostgreSQL 的 drizzle `pgTable` 对象。查询的类型
 * 安全由调用方的手写行接口与显式投影兜底（同 `to-sqlite.ts`）。
 *
 * @module @morlay/session-rdb/entities/to-postgres
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check as pgCheck,
  index,
  integer,
  pgTable,
  serial,
  text,
  unique,
  type AnyPgColumn,
  type AnyPgColumnBuilder,
  type AnyPgTable,
} from "drizzle-orm/pg-core";
import { toProperty, type ColumnDef, type TableDef } from "../entities/types.ts";

/** 构建过程中共享的目标表注册表（供列级 `references` 闭包延迟解析）。 */
type TableRegistry = Record<string, AnyPgTable>;

function buildColumn(c: ColumnDef, tables: TableRegistry): AnyPgColumnBuilder {
  // 具体 builder 类型与 AnyPgColumnBuilder 在方法层面不兼容，构建阶段用宽松类型。
  let col: any;
  switch (c.type) {
    case "text":
      col = text(c.name);
      break;
    case "serial":
      col = serial(c.name).primaryKey();
      break;
    case "integer": {
      const built = integer(c.name);
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
    case "bigint": {
      const built = bigint(c.name, { mode: "number" });
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
  }
  if (c.notNull) col = col.notNull();
  if (c.default !== undefined) col = col.default(c.default);
  if (c.unique) col = col.unique();
  if (c.references) {
    const { table, column, onDelete } = c.references;
    col = col.references(
      () => (tables[table] as unknown as Record<string, AnyPgColumn>)[toProperty(column)],
      { onDelete },
    );
  }
  return col;
}

/** 由表描述构建 PostgreSQL drizzle 表对象（按传入顺序；外键目标须先构建）。 */
export function toPostgresSchema(defs: readonly TableDef[]): Record<string, AnyPgTable> {
  const tables: TableRegistry = {};
  for (const def of defs) {
    const columns: Record<string, AnyPgColumnBuilder> = {};
    for (const c of def.columns) columns[toProperty(c.name)] = buildColumn(c, tables);
    const extra = (self: Record<string, unknown>) => [
      ...(def.checks ?? []).map((c) => pgCheck(c.name, sql.raw(c.expression))),
      ...(def.uniques ?? []).map((u) =>
        unique(u.name).on(
          ...(u.columns.map((name) => self[toProperty(name)] as AnyPgColumn) as [
            AnyPgColumn,
            ...AnyPgColumn[],
          ]),
        ),
      ),
      ...(def.indexes ?? []).map((i) =>
        index(i.name).on(
          ...(i.columns.map((name) => self[toProperty(name)] as AnyPgColumn) as [
            AnyPgColumn,
            ...AnyPgColumn[],
          ]),
        ),
      ),
    ];
    tables[def.name] = pgTable(
      def.name,
      columns as Record<string, AnyPgColumnBuilder>,
      extra as never,
    );
  }
  return tables;
}
