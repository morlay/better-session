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
