import { sql } from "drizzle-orm";
import {
  bigint,
  check as pgCheck,
  index,
  integer,
  pgSchema,
  pgTable,
  serial,
  text,
  unique,
  type AnyPgColumn,
  type AnyPgColumnBuilder,
  type AnyPgTable,
} from "drizzle-orm/pg-core";
import { toProperty, type ColumnDef, type TableDef } from "./types.ts";

type TableRegistry = Record<string, AnyPgTable>;

function buildColumn(name: string, c: ColumnDef, tables: TableRegistry): AnyPgColumnBuilder {
  // 具体 builder 类型与 AnyPgColumnBuilder 在方法层面不兼容，构建阶段用宽松类型。
  let col: any;
  switch (c.type) {
    case "text": {
      const built = text(name);
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
    case "serial":
      col = serial(name).primaryKey();
      break;
    case "integer": {
      const built = integer(name);
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
    case "bigint": {
      const built = bigint(name, { mode: "number" });
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

export function toPostgresSchema(
  defs: readonly TableDef[],
  schemaName = "public",
): Record<string, AnyPgTable> {
  const tables: TableRegistry = {};
  // `pgSchema(name).table` 使表对象携带 schema 限定（查询/DDL 显式引用，
  // 不依赖 search_path）；public 与无 schema 行为一致。
  const table = schemaName === "public" ? pgTable : pgSchema(schemaName).table;
  for (const def of defs) {
    const columns: Record<string, AnyPgColumnBuilder> = {};
    for (const [name, c] of Object.entries(def.columns)) {
      columns[toProperty(name)] = buildColumn(name, c, tables);
    }
    const extra = (self: Record<string, unknown>) => [
      ...Object.entries(def.checks ?? {}).map(([name, c]) => pgCheck(name, sql.raw(c.expression))),
      ...Object.entries(def.uniques ?? {}).map(([name, u]) =>
        unique(name).on(
          ...(u.columns.map((n) => self[toProperty(n)] as AnyPgColumn) as [
            AnyPgColumn,
            ...AnyPgColumn[],
          ]),
        ),
      ),
      ...Object.entries(def.indexes ?? {}).map(([name, i]) =>
        index(name).on(
          ...(i.columns.map((n) => self[toProperty(n)] as AnyPgColumn) as [
            AnyPgColumn,
            ...AnyPgColumn[],
          ]),
        ),
      ),
    ];
    tables[def.name] = (table as typeof pgTable)(
      def.name,
      columns as Record<string, AnyPgColumnBuilder>,
      extra as never,
    );
  }
  return tables;
}
