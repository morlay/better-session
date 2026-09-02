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

export function createTableSql(dialect: Dialect, def: TableDef, schema?: string): string {
  const parts = def.columns.map((c) => columnSql(dialect, c));
  for (const ck of def.checks ?? []) parts.push(`CHECK (${ck.expression})`);
  for (const u of def.uniques ?? []) {
    parts.push(`UNIQUE (${u.columns.map(quote).join(", ")})`);
  }
  const strict = dialect === "sqlite" ? " STRICT" : "";
  const qualified =
    schema === undefined || schema === "public"
      ? quote(def.name)
      : `${quote(schema)}.${quote(def.name)}`;
  return `CREATE TABLE IF NOT EXISTS ${qualified} (\n  ${parts.join(",\n  ")}\n)${strict}`;
}

export function createIndexSql(def: TableDef, name: string, schema?: string): string {
  const idx = def.indexes?.find((i) => i.name === name);
  if (idx === undefined) throw new Error(`unknown index "${name}" on table "${def.name}"`);
  const qualified =
    schema === undefined || schema === "public"
      ? quote(def.name)
      : `${quote(schema)}.${quote(def.name)}`;
  return `CREATE INDEX IF NOT EXISTS ${quote(idx.name)} ON ${qualified}(${idx.columns
    .map(quote)
    .join(", ")})`;
}

export function createTablesSql(
  dialect: Dialect,
  defs: readonly TableDef[],
  schema?: string,
): string[] {
  const statements: string[] = [];
  for (const def of defs) {
    statements.push(createTableSql(dialect, def, schema));
    for (const idx of def.indexes ?? []) statements.push(createIndexSql(def, idx.name, schema));
  }
  return statements;
}
