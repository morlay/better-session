/** drizzle util 层：方言无关的表结构描述（entities 与 adapters 共用）。 */

export type ColumnTypeName = "serial" | "integer" | "bigint" | "text";

export type DeleteAction = "cascade" | "set null" | "restrict" | "no action";

export interface ColumnDef {
  type: ColumnTypeName;
  notNull?: boolean;

  primaryKey?: boolean;

  default?: string | number;

  unique?: boolean;

  references?: {
    table: string;
    column: string;
    onDelete?: DeleteAction;
  };
}

export interface CheckDef {
  expression: string;
}

export interface UniqueDef {
  columns: string[];
}

export interface IndexDef {
  columns: string[];
}

/** 表结构描述：columns / checks / uniques / indexes 以 Record 键为名，天然唯一。 */
export interface TableDef {
  name: string;
  columns: Record<string, ColumnDef>;
  checks?: Record<string, CheckDef>;
  uniques?: Record<string, UniqueDef>;
  indexes?: Record<string, IndexDef>;
}

export function toProperty(name: string): string {
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}
