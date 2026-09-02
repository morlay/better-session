export type ColumnTypeName = "serial" | "integer" | "bigint" | "text";

export type DeleteAction = "cascade" | "set null" | "restrict" | "no action";

export interface ColumnDef {
  name: string;
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
  name: string;
  expression: string;
}

export interface UniqueDef {
  name?: string;
  columns: string[];
}

export interface IndexDef {
  name: string;
  columns: string[];
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  checks?: CheckDef[];
  uniques?: UniqueDef[];
  indexes?: IndexDef[];
}

export function toProperty(name: string): string {
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}
