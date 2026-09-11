// drizzle-kit 入口：v2 快照（PG，具名导出表对象）。
import { toPostgresSchema } from "../adapters/to-postgres.ts";
import { postgresTableDefsV2 } from "../entities/v2/index.ts";

const tables = toPostgresSchema(postgresTableDefsV2);

export const tPersistenceState = tables["t_persistence_state"]!;
export const tSchemaMeta = tables["t_schema_meta"]!;
export const tSessions = tables["t_sessions"]!;
export const tEvents = tables["t_events"]!;
export const tSessionEvents = tables["t_session_events"]!;
