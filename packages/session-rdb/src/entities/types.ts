/**
 * 方言无关的表描述类型：`src/entities/*.ts` 以本模块的类型声明每张表一次，
 * SQLite 与 PostgreSQL 的表对象（drizzle `sqliteTable` / `pgTable`）和建表
 * DDL 都由这些描述生成——实体定义是唯一来源，不再手写两套 drizzle 表与裸
 * SQL DDL。
 *
 * @module @morlay/session-rdb/entities/types
 */

/**
 * 列类型（方言无关）：
 * - `serial`  — 自增主键（sqlite `INTEGER PRIMARY KEY AUTOINCREMENT` /
 *   pg `SERIAL PRIMARY KEY`）；
 * - `integer` — 32 位整数（sqlite `INTEGER` / pg `INTEGER`）；
 * - `bigint`  — 64 位整数（sqlite `INTEGER` / pg `BIGINT`，用于毫秒时间戳）；
 * - `text`    — 文本（sqlite `TEXT` / pg `TEXT`）。
 */
export type ColumnTypeName = "serial" | "integer" | "bigint" | "text";

/** 外键级联动作（drizzle `UpdateDeleteAction` 的子集）。 */
export type DeleteAction = "cascade" | "set null" | "restrict" | "no action";

/** 一列的定义（物理列名一律 `f_` 前缀）。 */
export interface ColumnDef {
  /** 物理列名（`f_` 前缀）。 */
  name: string;
  type: ColumnTypeName;
  notNull?: boolean;
  /** 列级主键；`serial` 列同时携带自增语义。 */
  primaryKey?: boolean;
  /** 字面量默认值（字符串/数字）。 */
  default?: string | number;
  /** 列级 UNIQUE。 */
  unique?: boolean;
  /** 列级外键（目标表 + 目标列 + 级联动作）。 */
  references?: {
    table: string;
    column: string;
    onDelete?: DeleteAction;
  };
}

/** 表级 CHECK 约束（expression 为 SQL 片段，如 `f_singleton = 1`）。 */
export interface CheckDef {
  name: string;
  expression: string;
}

/** 表级 UNIQUE 约束。 */
export interface UniqueDef {
  name?: string;
  columns: string[];
}

/** 普通索引（建表后独立 CREATE INDEX）。 */
export interface IndexDef {
  name: string;
  columns: string[];
}

/** 一张表的完整描述。 */
export interface TableDef {
  /** 物理表名（`t_` 前缀）。 */
  name: string;
  columns: ColumnDef[];
  checks?: CheckDef[];
  uniques?: UniqueDef[];
  indexes?: IndexDef[];
}

/** 把物理列名转成 drizzle 表对象的属性名（`f_session_id` → `fSessionId`）。 */
export function toProperty(name: string): string {
  return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}
