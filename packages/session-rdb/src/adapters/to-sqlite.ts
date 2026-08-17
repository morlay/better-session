/**
 * 从方言无关的表描述生成 SQLite 的 drizzle `sqliteTable` 对象。查询的类型
 * 安全由调用方的手写行接口（`backend.ts` 的 `SessionRow` / `EventRow` /
 * `EventInsert`）与显式投影兜底——drizzle 无法从运行时构建的列映射保留
 * 精确的列类型。
 *
 * @module @morlay/session-rdb/entities/to-sqlite
 */

import { sql } from "drizzle-orm";
import {
  check as sqliteCheck,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  type AnySQLiteColumn,
  type AnySQLiteTable,
  type SQLiteColumnBuilder,
} from "drizzle-orm/sqlite-core";
import { toProperty, type ColumnDef, type TableDef } from "../entities/types.ts";

/** 构建过程中共享的目标表注册表（供列级 `references` 闭包延迟解析）。 */
type TableRegistry = Record<string, AnySQLiteTable>;

function buildColumn(c: ColumnDef, tables: TableRegistry): SQLiteColumnBuilder {
  // 具体 builder 类型（SQLiteIntegerBuilder / SQLiteTextBuilder）与基类
  // `SQLiteColumnBuilder` 在方法层面不兼容（泛型逆变），构建阶段用宽松类型
  // 合并，返回时收窄为基类；查询的类型安全由手写行接口兜底。
  let col: any;
  switch (c.type) {
    case "text":
      col = text(c.name);
      break;
    case "serial":
      col = integer(c.name).primaryKey({ autoIncrement: true });
      break;
    case "integer":
    case "bigint": {
      const built = integer(c.name);
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
      () => (tables[table] as unknown as Record<string, AnySQLiteColumn>)[toProperty(column)],
      { onDelete },
    );
  }
  return col as SQLiteColumnBuilder;
}

/** 由表描述构建 SQLite drizzle 表对象（按传入顺序；外键目标须先构建）。 */
export function toSqliteSchema(defs: readonly TableDef[]): Record<string, AnySQLiteTable> {
  const tables: TableRegistry = {};
  for (const def of defs) {
    const columns: Record<string, SQLiteColumnBuilder> = {};
    for (const c of def.columns) columns[toProperty(c.name)] = buildColumn(c, tables);
    const extra = (self: Record<string, unknown>) => [
      ...(def.checks ?? []).map((c) => sqliteCheck(c.name, sql.raw(c.expression))),
      ...(def.uniques ?? []).map((u) =>
        unique(u.name).on(
          ...(u.columns.map((name) => self[toProperty(name)] as AnySQLiteColumn) as [
            AnySQLiteColumn,
            ...AnySQLiteColumn[],
          ]),
        ),
      ),
      ...(def.indexes ?? []).map((i) =>
        index(i.name).on(
          ...(i.columns.map((name) => self[toProperty(name)] as AnySQLiteColumn) as [
            AnySQLiteColumn,
            ...AnySQLiteColumn[],
          ]),
        ),
      ),
    ];
    tables[def.name] = sqliteTable(
      def.name,
      columns as Record<string, SQLiteColumnBuilder>,
      extra as never,
    );
  }
  return tables;
}
