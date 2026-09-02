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

export const sqliteTableDefs = [persistenceState, sessions, events, sessionEvents] as const;

export const postgresTableDefs = [
  persistenceState,
  schemaMeta,
  sessions,
  events,
  sessionEvents,
] as const;
