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
import { toProperty, type ColumnDef, type TableDef } from "./types.ts";

type TableRegistry = Record<string, AnySQLiteTable>;

function buildColumn(name: string, c: ColumnDef, tables: TableRegistry): SQLiteColumnBuilder {
  // 具体 builder 类型与基类在方法层面不兼容（泛型逆变），构建阶段用宽松
  // 类型合并，返回时收窄为基类；查询类型安全由手写行接口兜底。
  let col: any;
  switch (c.type) {
    case "text": {
      const built = text(name);
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
    case "serial":
      col = integer(name).primaryKey({ autoIncrement: true });
      break;
    case "integer":
    case "bigint": {
      const built = integer(name);
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

export function toSqliteSchema(defs: readonly TableDef[]): Record<string, AnySQLiteTable> {
  const tables: TableRegistry = {};
  for (const def of defs) {
    const columns: Record<string, SQLiteColumnBuilder> = {};
    for (const [name, c] of Object.entries(def.columns)) {
      columns[toProperty(name)] = buildColumn(name, c, tables);
    }
    const extra = (self: Record<string, unknown>) => [
      ...Object.entries(def.checks ?? {}).map(([name, c]) =>
        sqliteCheck(name, sql.raw(c.expression)),
      ),
      ...Object.entries(def.uniques ?? {}).map(([name, u]) =>
        unique(name).on(
          ...(u.columns.map((n) => self[toProperty(n)] as AnySQLiteColumn) as [
            AnySQLiteColumn,
            ...AnySQLiteColumn[],
          ]),
        ),
      ),
      ...Object.entries(def.indexes ?? {}).map(([name, i]) =>
        index(name).on(
          ...(i.columns.map((n) => self[toProperty(n)] as AnySQLiteColumn) as [
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
