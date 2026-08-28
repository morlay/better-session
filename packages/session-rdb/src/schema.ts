/**
 * Schema + event classification for the RDB session-persistence backend.
 *
 * The table layout follows the playpen-session store (three-table split):
 * `t_sessions` holds the header plus the head cursor, `t_events` holds each
 * event as a GLOBALLY addressable entity (event id + parent chain +
 * kind/role/name/action-id dimensions), and `t_session_events` bridges
 * sessions to events in per-session seq order.
 *
 * Naming is uniform: every table carries the `t_` prefix and every column the
 * `f_` prefix. The entities are declared ONCE in `src/entities/` (dialect-free
 * table descriptions); this module derives the SQLite drizzle tables from
 * them (STRICT + version/identity pragmas live with the SQLite backend in
 * `sqlite.ts`). There is no migration toolchain and no hand-written DDL.
 *
 * Delta content is NOT persisted: `assistant/chunk` events are dropped at
 * write time, and surviving events are re-numbered to a dense persisted seq
 * (`f_original_seq` keeps the upstream seq, so `sourceEventSeqs` provenance
 * can be remapped on read — see `log.ts`). This gives the backend the same
 * "ephemeral chunks stay out of the canonical log" semantics the persistence
 * proposal records, without requiring the upstream session layer to skip seqs.
 *
 * @module @morlay/session-rdb/schema
 */

import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { toSqliteSchema } from "./adapters/index.ts";
import { sqliteTableDefs } from "./entities/index.ts";

/**
 * The on-disk schema version. Bumped only on a breaking change to the table
 * layout; orthogonal to a session's own `version` (which versions the EVENT
 * vocabulary, stored per session in the `t_sessions` row).
 */
export const SCHEMA_VERSION = 1;

/** SQLite application id protecting unrelated databases from persistence writes. */
export const SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 0x44534850;

/**
 * Event types whose CONTENT is not persisted: the backend drops these rows
 * entirely and re-numbers the surviving events to a dense persisted seq.
 * Mirrors the persistence proposal's "ephemeral events never enter the
 * canonical log" split.
 */
export const EPHEMERAL_EVENT_TYPES = ["assistant/chunk"] as const;

/** `t_events.f_encoding` value: JSON text. Future compression would switch this per row. */
export const EVENT_ENCODING = "json";

/**
 * SQLite drizzle tables derived from the single entity definitions in
 * `src/entities/`. The runtime column objects are authoritative; TS type
 * safety of queries is carried by the hand-written row interfaces in
 * `backend.ts` (drizzle cannot infer precise column types from a runtime-built
 * column map, so the table handles are deliberately loose).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqliteTables: Record<string, any> = toSqliteSchema(sqliteTableDefs);

/** `t_persistence_state` — the singleton row holding the store identity. */
export const tPersistenceState = sqliteTables["t_persistence_state"]!;

/** `t_sessions` — the out-of-log metadata plus the playpen-style head cursor. */
export const tSessions = sqliteTables["t_sessions"]!;

/** `t_events` — the globally addressable persisted event entity. */
export const tEvents = sqliteTables["t_events"]!;

/** `t_session_events` — the session↔event bridge. */
export const tSessionEvents = sqliteTables["t_session_events"]!;

/**
 * A row of the `t_sessions` table — the out-of-log metadata ({@link SessionHeader})
 * plus the playpen-style head cursor (the last committed event id and seq). The
 * row's EXISTENCE is the materialization signal: it is written only by the
 * first non-empty append (lazy materialization), so a created-but-never-appended
 * session has no row and is absent from `list`.
 *
 * The canonical shared shape lives in `backend.ts` (dialect-neutral); the
 * drizzle-derived select model is structurally compatible.
 */
export type { SessionRow } from "./backend.ts";

/** @see {@link import("./backend.ts").EventRow} — shared with the PostgreSQL backend. */
export type { EventRow } from "./backend.ts";

/**
 * Journal modes the backend will run under. `wal` is the default and the
 * durability model the persistence ADR records; the rollback-journal modes
 * (`delete`/`truncate`/`persist`) exist for filesystems where WAL's
 * shared-memory files do not work (network mounts). `memory`/`off` are
 * excluded: dropping journal durability silently contradicts what this
 * backend promises.
 */
export type JournalMode = "wal" | "delete" | "truncate" | "persist";

/**
 * How long a connection waits for a contended write lock before failing with
 * `SQLITE_BUSY`. SQLite's default is 0 (fail immediately): with two processes
 * sharing one database (a second `dsh` instance on the same `sessions.sqlite`),
 * every append that meets an in-flight commit would fail and that process's
 * session would silently lose its tail. A nonzero wait makes the contention
 * window a queue instead of a loss.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Whether an event type is ephemeral (its content must not be persisted).
 * @param type - the upstream `SessionEvent.type`.
 * @returns true for delta events the backend drops at write time.
 */
export function isEphemeralType(type: string): boolean {
  return (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Whether an event must be persisted. An event is dropped at write time when
 * its type is ephemeral (content not persisted) OR the writer marked it
 * `ignorable` — the envelope contract promises loss of an ignorable event
 * cannot affect reconstruction, so it never enters the canonical log (the
 * upstream seq is still recorded for provenance pruning, exactly like a
 * dropped delta). `session-branch/version` is a branch-layer lineage fact
 * carried as an ignorable seed event: it stays in the LIVE log but is NOT
 * persisted here — the branch provider persists it in its own version table
 * (`t_branch_versions`), keeping canonical-log semantics intact.
 *
 * `ignorable` is a downstream envelope extension (upstream `SessionEvent` has
 * no such field), so it is read structurally from the event record.
 */
export function isPersistedEvent(event: SessionEvent): boolean {
  return (
    !isEphemeralType(event.type) &&
    (event as SessionEvent & { ignorable?: unknown }).ignorable !== true
  );
}

/**
 * Map a persisted event onto the playpen event dimensions. `f_kind` is the
 * upstream type; `f_role`/`f_name`/`f_action_id` are the playpen classification
 * columns. Unknown (plugin-merged) event types keep the playpen defaults so a
 * future extension can classify them without a schema change.
 * @param event - the event to classify (never an ephemeral type at write time).
 * @returns the role, name, and action-id column values.
 */
export function eventDimensions(event: SessionEvent): {
  role: string;
  name: string;
  actionId: string;
} {
  switch (event.type) {
    case "turn/start":
    case "turn/end":
    case "step/start":
    case "step/end":
    case "session/end-seed":
      return { role: "turn", name: "", actionId: "" };
    case "user/message":
    case "request/header":
    case "request/context":
      return { role: "user", name: "", actionId: "" };
    case "assistant/message":
      return { role: "model", name: "", actionId: "" };
    case "tool/call":
      return { role: "function", name: event.data.name, actionId: event.data.callId };
    case "tool/result": {
      // Optional chain: the coordinator migrates pre-identity legacy events
      // only on READ; an append may still carry the old shape without `message`.
      const block = event.data.message?.content[0];
      return { role: "function", name: "", actionId: block?.toolCallId ?? "" };
    }
    case "todo/write":
      return { role: "state", name: "todos", actionId: "" };
    default:
      return { role: "", name: "", actionId: "" };
  }
}
