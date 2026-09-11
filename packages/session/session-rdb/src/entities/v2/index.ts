import { persistenceState } from "../v3/persistence-state.ts";
import { schemaMeta } from "../v3/schema-meta.ts";
import { sessions } from "../v3/sessions.ts";
import { events } from "../v3/events.ts";
import { sessionEvents } from "./session-events.ts";

export { persistenceState };
export { schemaMeta };
export { sessions };
export { events };
export { sessionEvents };

export const sqliteTableDefsV2 = [persistenceState, sessions, events, sessionEvents] as const;
export const postgresTableDefsV2 = [
  persistenceState,
  schemaMeta,
  sessions,
  events,
  sessionEvents,
] as const;
