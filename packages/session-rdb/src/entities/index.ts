/**
 * 实体纯定义：每张表一个文件，方言无关的表描述（列 / 约束 / 索引 / 外键）。
 * 具体后端的 drizzle 表对象与建表 DDL 由 `src/adapters/` 从这里转化生成。
 *
 * @module @morlay/session-rdb/entities
 */

import { persistenceState } from "./persistence-state.ts";
import { schemaMeta } from "./schema-meta.ts";
import { sessions } from "./sessions.ts";
import { events } from "./events.ts";
import { sessionEvents } from "./session-events.ts";

export { persistenceState };
export { schemaMeta };
export { sessions };
export { events };
export { sessionEvents };
export type {
  ColumnDef,
  TableDef,
  CheckDef,
  UniqueDef,
  IndexDef,
  ColumnTypeName,
  DeleteAction,
} from "./types.ts";

/** SQLite 后端使用的表（不含 pg 专用的 `t_schema_meta`）。 */
export const sqliteTableDefs = [persistenceState, sessions, events, sessionEvents] as const;

/** PostgreSQL 后端使用的表。 */
export const postgresTableDefs = [
  persistenceState,
  schemaMeta,
  sessions,
  events,
  sessionEvents,
] as const;
