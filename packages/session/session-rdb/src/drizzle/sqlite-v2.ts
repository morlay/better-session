import { toSqliteSchema } from "../adapters/to-sqlite.ts";
import { sqliteTableDefsV2 } from "../entities/v2/index.ts";

const tables = toSqliteSchema(sqliteTableDefsV2);

export const tPersistenceState = tables["t_persistence_state"]!;
export const tSessions = tables["t_sessions"]!;
export const tEvents = tables["t_events"]!;
export const tSessionEvents = tables["t_session_events"]!;
