import { persistenceState } from "./persistence-state.ts";
import { schemaMeta } from "./schema-meta.ts";
import { sessions } from "./sessions.ts";
import { events } from "./events.ts";
import { sessionEvents } from "./session-events.ts";
import { storageUnits } from "./storage-units.ts";
import { workspaces } from "./workspaces.ts";
import { workspaceSessions } from "./workspace-sessions.ts";
import { workspaceState } from "./workspace-state.ts";
import { sessionProjcacheRows } from "./session-projcache-rows.ts";

export { persistenceState };
export { schemaMeta };
export { sessions };
export { events };
export { sessionEvents };
export { storageUnits };
export { workspaces };
export { workspaceSessions };
export { workspaceState };
export { sessionProjcacheRows };

export const sqliteTableDefs = [
  persistenceState,
  schemaMeta,
  sessions,
  events,
  sessionEvents,
  storageUnits,
  workspaces,
  workspaceSessions,
  workspaceState,
  sessionProjcacheRows,
] as const;

export const postgresTableDefs = [
  persistenceState,
  schemaMeta,
  sessions,
  events,
  sessionEvents,
  storageUnits,
  workspaces,
  workspaceSessions,
  workspaceState,
  sessionProjcacheRows,
] as const;
