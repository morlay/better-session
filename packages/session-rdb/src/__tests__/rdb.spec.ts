import { randomUUID } from "node:crypto";
import { ToolCallId, createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it } from "vitest";
import { EmptySettings } from "./testing/helpers.ts";
import { Context } from "@deepseek-ai/cordis";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import type {
  Session,
  SessionEvent,
  SurfaceEvent,
  SurfaceEventType,
} from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite, { SCHEMA_VERSION, EPHEMERAL_EVENT_TYPES } from "../index.ts";
import {
  buildSeqMap,
  normalizeSurfaceReplaceProvenance,
  remapProvenance,
  remapShadowedRange,
  remapSurfaceOp,
  rowToEvent,
  rowToMeta,
  scanRows,
} from "../log.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  eventDimensions,
  isEphemeralType,
  isPersistedEvent,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  type EventRow,
  type SessionRow,
} from "../schema.ts";
import { openDatabase } from "../sqlite.ts";
import { runPersistenceContract, meta, oneTurnLog, appendLog } from "./testing/contract.ts";
import { runCoordinatorContract, type CoordinatorFixture } from "./testing/coordinator-contract.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function expectFlushError(promise: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected flush to reject");
}

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-sqlite-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

/**
 * Hand-insert one event as an events + session_events pair (the backend's write
 * path always keeps them in step; a bridge row without an event row never
 * joins). Used to fabricate on-disk states (legacy logs, torn tails) that the
 * normal append path cannot produce.
 * @returns the minted event id (the bridge row's parent for the next event).
 */
function insertEventRow(
  db: DatabaseSync,
  sessionId: string,
  seq: number,
  kind: string,
  data: unknown,
  parentId: string,
): string {
  const eventId = randomUUID();
  db.prepare(`
    INSERT INTO t_events
      (f_event_id, f_parent_id, f_kind, f_role, f_name, f_action_id, f_encoding,
       f_data, f_created_at, f_original_seq, f_source_event_seqs, f_surface_op)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    parentId,
    kind,
    "",
    "",
    "",
    "json",
    JSON.stringify(data),
    seq + 1,
    seq,
    null,
    null,
  );
  db.prepare(
    "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence) VALUES (?, ?, ?)",
  ).run(sessionId, eventId, seq);
  return eventId;
}

/** A context with the session store + SQLite backend, plus a teardown. */
async function backend(path = ":memory:"): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
  return { ctx, dispose: () => fiber.dispose() };
}

// Run the same backend-agnostic contract as JSONL to pin identical semantics.
runPersistenceContract("sqlite", async () => {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose();
    },
  };
});

// A file-backed database lets two mounts share rows across reload. `corruptTail`
// inserts an unparsable row past the committed seq (as an events + session_events
// pair, since a bridge row without an event row never joins), exercising
// coordinator repair against real database rows.
runCoordinatorContract("sqlite", async (): Promise<CoordinatorFixture> => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-sqlite-coord-"));
  const path = join(dir, "sessions.db");
  return {
    mount: async (ctx) => {
      // HMR 测试会在同一 ctx 上多次 reload 后端；settings 服务只注册一次。
      if (ctx.reflect.get("settings") === undefined) {
        await ctx.plugin(EmptySettings);
      }
      return await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    },
    corruptTail: async (id) => {
      const db = openDatabase(path, "wal");
      const head = db
        .prepare("SELECT f_head_event_id, f_head_sequence FROM t_sessions WHERE f_session_id = ?")
        .get(id) as { f_head_event_id: string; f_head_sequence: number };
      const next = head.f_head_sequence + 1;
      const eventId = randomUUID();
      db.prepare(`
        INSERT INTO t_events
          (f_event_id, f_parent_id, f_kind, f_role, f_name, f_action_id, f_encoding,
           f_data, f_created_at, f_original_seq, f_source_event_seqs, f_surface_op)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        head.f_head_event_id,
        "assistant/chunk",
        "model",
        "",
        "",
        "json",
        "{not valid json",
        99,
        next,
        null,
        null,
      );
      db.prepare(
        "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence) VALUES (?, ?, ?)",
      ).run(id, eventId, next);
      db.close();
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describe("eventDimensions", () => {
  it("classifies boundary events as turn role", () => {
    const { role, name, actionId } = eventDimensions({
      type: "turn/start",
      seq: 0,
      time: 1,
      data: { turn: 1 },
    });
    expect([role, name, actionId]).toEqual(["turn", "", ""]);
  });

  it("classifies messages as user/model roles", () => {
    expect(
      eventDimensions({
        type: "user/message",
        seq: 1,
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
      }).role,
    ).toBe("user");
    expect(
      eventDimensions({
        type: "assistant/message",
        seq: 2,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
      }).role,
    ).toBe("model");
  });

  it("extracts the function name and call id from tool/call", () => {
    const dims = eventDimensions({
      type: "tool/call",
      seq: 4,
      time: 5,
      data: { turn: 1, step: 1, callId: ToolCallId("call-1"), name: "read", arguments: "{}" },
    });
    expect(dims).toEqual({ role: "function", name: "read", actionId: "call-1" });
  });

  it("extracts the call id from tool/result and classifies todo/write as state", () => {
    const callId = ToolCallId("call-2");
    const result = eventDimensions({
      type: "tool/result",
      seq: 5,
      time: 6,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: "user",
          content: [{ type: "tool-result", toolCallId: callId, content: [], isError: false }],
          source: { kind: "tool", callId },
        }),
      },
    });
    expect(result).toEqual({ role: "function", name: "", actionId: "call-2" });
    expect(eventDimensions({ type: "todo/write", seq: 6, time: 7, data: { todos: [] } })).toEqual({
      role: "state",
      name: "todos",
      actionId: "",
    });
  });

  it("keeps playpen defaults for unknown plugin-merged event types", () => {
    expect(
      eventDimensions({ type: "plugin/custom", seq: 0, time: 1, data: {} } as SessionEvent),
    ).toEqual({ role: "", name: "", actionId: "" });
  });
});

describe("isEphemeralType / EPHEMERAL_EVENT_TYPES", () => {
  it("treats assistant/chunk as ephemeral and everything else as persisted", () => {
    expect(EPHEMERAL_EVENT_TYPES).toEqual(["assistant/chunk"]);
    expect(isEphemeralType("assistant/chunk")).toBe(true);
    expect(isEphemeralType("assistant/message")).toBe(false);
    expect(isEphemeralType("turn/start")).toBe(false);
  });
});

describe("isPersistedEvent", () => {
  // `ignorable` 是下游信封扩展（上游 SessionEvent 无此字段），测试里
  // 结构化构造：用 `Partial<SessionEvent & { ignorable?: unknown }>` 表达。
  const ev = (extra: Partial<SessionEvent & { ignorable?: unknown }> = {}): SessionEvent =>
    ({ type: "plugin/x", seq: 0, time: 1, data: null, ...extra }) as SessionEvent;

  it("drops ephemeral types and ignorable events, keeps everything else", () => {
    expect(isPersistedEvent(ev({ type: "assistant/chunk" }))).toBe(false);
    expect(isPersistedEvent(ev({ ignorable: true }))).toBe(false);
    // An ephemeral type marked ignorable is dropped either way.
    expect(isPersistedEvent(ev({ type: "assistant/chunk", ignorable: true }))).toBe(false);
    expect(isPersistedEvent(ev())).toBe(true);
    // A non-`true` ignorable value is a dirty envelope (only `true` is legal);
    // treat it as a required event: persist it, and let the read path's
    // assertEventsSupported refuse the unknown type.
    const dirty = {
      type: "plugin/x",
      seq: 0,
      time: 1,
      data: null,
      ignorable: false,
    } as unknown as SessionEvent;
    expect(isPersistedEvent(dirty)).toBe(true);
  });
});

describe("scanRows", () => {
  // scanRows works off EventRows (data is a JSON string column); build them from
  // SessionEvents so the unit tests read in terms of the event vocabulary. With
  // no delta filtering the persisted seq equals the original seq.
  const rows = (events: SessionEvent[]): EventRow[] =>
    events.map((e) => {
      const se = e as SessionEvent<SurfaceEventType>;
      return {
        fSequence: e.seq,
        fOriginalSeq: e.seq,
        fKind: e.type,
        fCreatedAt: e.time,
        fData: JSON.stringify(e.data),
        fSourceEventSeqs:
          se.sourceEventSeqs === undefined ? null : JSON.stringify(se.sourceEventSeqs),
        fSurfaceOp: se.surfaceOp !== undefined ? JSON.stringify(se.surfaceOp) : null,
      };
    });

  it("preserves the full log when it ends exactly on a turn/end (no torn tail)", () => {
    const { preserved, tornFrom } = scanRows(rows(oneTurnLog()));
    expect(preserved).toEqual(oneTurnLog());
    expect(tornFrom).toBeUndefined();
  });

  it("PRESERVES the real events of an interrupted turn after the last turn/end", () => {
    const withOpenTurn: SessionEvent[] = [
      ...oneTurnLog(),
      {
        type: "turn/start",
        seq: 6,
        time: 7,
        data: { turn: 2 },
      },
      { type: "step/start", seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ];
    const { preserved, tornFrom } = scanRows(rows(withOpenTurn));
    expect(preserved.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tornFrom).toBeUndefined();
  });

  it("preserves the contiguous prefix and flags a torn tail at a seq gap", () => {
    const gapped: SessionEvent[] = [
      {
        type: "turn/start",
        seq: 0,
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
    ];
    const { preserved, tornFrom } = scanRows(rows(gapped));
    expect(preserved.map((e) => e.seq)).toEqual([0]);
    expect(tornFrom).toBe(1);
  });

  it("an empty log preserves nothing and has no torn tail", () => {
    expect(scanRows([])).toEqual({ preserved: [] });
  });

  it("throws on a seq gap inside the committed region (before the last turn/end)", () => {
    const gapped: SessionEvent[] = [
      {
        type: "turn/start",
        seq: 0,
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
      { type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ];
    expect(() => scanRows(rows(gapped))).toThrow(/seq gap in committed region/);
  });

  it("throws on an unparsable row inside the committed region", () => {
    const withCorruptCommitted: EventRow[] = [
      {
        fSequence: 0,
        fOriginalSeq: 0,
        fKind: "turn/start",
        fCreatedAt: 1,
        fData: "{not json",
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
      {
        fSequence: 1,
        fOriginalSeq: 1,
        fKind: "turn/end",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, reason: { kind: "completed" } }),
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
    ];
    expect(() => scanRows(withCorruptCommitted)).toThrow(/unparsable committed event/);
  });

  it("tolerates an unparsable torn-tail row after the last turn/end", () => {
    const withCorruptTail: EventRow[] = [
      ...rows(oneTurnLog()),
      {
        fSequence: 6,
        fOriginalSeq: 6,
        fKind: "turn/start",
        fCreatedAt: 7,
        fData: "{not json",
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
    ];
    const { preserved, tornFrom } = scanRows(withCorruptTail);
    expect(preserved).toEqual(oneTurnLog());
    expect(tornFrom).toBe(6);
  });
});

describe("rowToMeta", () => {
  it("rejects fractional stored creation metadata", () => {
    expect(() =>
      rowToMeta({
        fSessionId: "fractional",
        fHeadEventId: "",
        fHeadSequence: -1,
        fVersion: 0,
        fCreatedAt: 1.5,
        fCwd: null,
        fParentSession: null,
        fSeedLength: null,
        fOrigin: null,
        fDelegationDepth: null,
        fIncarnation: "fractional",
        fRevision: 1,
      } satisfies SessionRow),
    ).toThrow("stored session createdAt must be a non-negative safe integer");
  });
});

describe("rowToEvent", () => {
  it("parses surface fields from EventRow columns", () => {
    const row: EventRow = {
      fSequence: 0,
      fOriginalSeq: 0,
      fKind: "assistant/message",
      fCreatedAt: 1,
      fData: JSON.stringify({ turn: 1, step: 1, content: [] }),
      fSourceEventSeqs: JSON.stringify([3, 5]),
      fSurfaceOp: JSON.stringify("append"),
    };
    const event = rowToEvent(row);
    expect(event.seq).toBe(0);
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([3, 5]);
    expect((event as SurfaceEvent).surfaceOp).toBe("append");
  });

  it("remaps sourceEventSeqs through the upstream→persisted seq map", () => {
    const row: EventRow = {
      fSequence: 4,
      fOriginalSeq: 7,
      fKind: "assistant/message",
      fCreatedAt: 1,
      fData: JSON.stringify({ turn: 1, step: 1, content: [] }),
      fSourceEventSeqs: JSON.stringify([2, 6]),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 0, end: 1 }),
    };
    const map = new Map<number, number>([
      [0, 0],
      [1, 1],
      [2, 2],
      [6, 3],
      [7, 4],
    ]);
    const event = rowToEvent(row, map);
    expect(event.seq).toBe(4);
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([2, 3]);
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 0, end: 1 });
  });

  it("drops unmapped sourceEventSeqs entries (never mixes upstream with dense seqs)", () => {
    const row: EventRow = {
      fSequence: 1,
      fOriginalSeq: 1,
      fKind: "user/message",
      fCreatedAt: 1,
      fData: JSON.stringify({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
      fSourceEventSeqs: JSON.stringify([9]),
      fSurfaceOp: null,
    };
    const event = rowToEvent(row, new Map<number, number>([[1, 1]]));
    // upstream 9 has no persisted row → the reference is pruned, and an empty
    // provenance list is omitted entirely (matching the write path's null).
    expect((event as SurfaceEvent).sourceEventSeqs).toBeUndefined();
  });

  it("keeps resume-era DENSE sourceEventSeqs and a dense replace range (f_sequence wins)", () => {
    // 新代码时代:上游 resume 后 live log == 稠密 log,checkpoint 引用稠密 seq
    // (4564/4565 compaction、2107/2101/2114 surface 节点),replace range 也是
    // 稠密。读取时这些值必须原样保留,不能按「上游→稠密」重映射。
    const row: EventRow = {
      fSequence: 4566,
      fOriginalSeq: 4566,
      fKind: "user/message",
      fCreatedAt: 1,
      fData: JSON.stringify({
        content: [{ type: "text", text: "checkpoint" }],
        source: { kind: "user" },
      }),
      fSourceEventSeqs: JSON.stringify([4564, 4565, 2107, 2101, 2114]),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 2107, end: 4556 }),
    };
    const seqMap = new Map<number, number>([
      [4564, 4564], // compaction/start self-map
      [4565, 4565], // compaction/summary self-map
      [2196, 98], // unrelated upstream collision, not cited here
    ]);
    const denseTypeMap = new Map<number, string>([
      [4564, "compaction/start"],
      [4565, "compaction/summary"],
      [2107, "user/message"],
      [2101, "assistant/message"],
      [2114, "user/message"],
      [4556, "tool/result"],
    ]);
    const event = rowToEvent(row, seqMap, denseTypeMap);
    // 4564/4565: dense 非 surface 但上游 self-map(映射回自身)→ 仍为原值。
    // 2107/2101/2114: dense surface → 原值保留。
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([2101, 2107, 2114, 4564, 4565]);
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 2107, end: 4556 });
  });

  it("remaps an upstream seq that collides with a non-surface dense seq", () => {
    // 旧数据:replace end=5 是「上游 seq 5」(assistant/message),稠密 5 恰好是
    // turn/end(非 surface)——启发式必须走上游映射(5 → 3),否则 end 指向
    // 非节点导致 "end seq not found in surface"。
    const row: EventRow = {
      fSequence: 10,
      fOriginalSeq: 12,
      fKind: "assistant/message",
      fCreatedAt: 1,
      fData: JSON.stringify({ turn: 2, step: 1, content: [] }),
      fSourceEventSeqs: JSON.stringify([1, 5]),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 1, end: 5 }),
    };
    const seqMap = new Map<number, number>([
      [1, 1],
      [5, 3],
    ]);
    const denseTypeMap = new Map<number, string>([
      [1, "user/message"],
      [3, "assistant/message"],
      [5, "turn/end"],
    ]);
    const event = rowToEvent(row, seqMap, denseTypeMap);
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 1, end: 3 });
  });

  it("normalizes remapped sourceEventSeqs: prunes, sorts, and de-duplicates", () => {
    // A checkpoint user/message after a rewind: references span the reused
    // upstream space — [8, 2, 8, 9, 15] where 15 has no row, 2→20, 8→30, 9→31.
    const row: EventRow = {
      fSequence: 40,
      fOriginalSeq: 40,
      fKind: "user/message",
      fCreatedAt: 1,
      fData: JSON.stringify({
        content: [{ type: "text", text: "checkpoint" }],
        source: { kind: "user" },
      }),
      fSourceEventSeqs: JSON.stringify([8, 2, 8, 9, 15]),
      fSurfaceOp: JSON.stringify("append"),
    };
    const map = new Map<number, number>([
      [2, 20],
      [8, 30],
      [9, 31],
    ]);
    const event = rowToEvent(row, map);
    // 15 unmapped → dropped; 8 dup → one; sorted → [20, 30, 31].
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([20, 30, 31]);
  });

  it("remapProvenance prunes unresolvable refs, sorts, and de-duplicates", () => {
    const remap = (seq: number): number | undefined => (seq % 2 === 0 ? seq * 10 : undefined);
    expect(remapProvenance([5, 2, 4, 2, 6], remap)).toEqual([20, 40, 60]);
    expect(remapProvenance([1, 3], remap)).toEqual([]);
    expect(remapProvenance([], remap)).toEqual([]);
  });

  it("normalizeSurfaceReplaceProvenance merges the dense range's surface nodes into a replace's provenance", () => {
    // checkpoint user/message (seq 40) replaces dense range [7..9]; its stored
    // provenance covers only [7, 8] and the range's surface node (user/message
    // @ 8) is already cited — but after a rewind reused the upstream space the
    // shadowed validation requires EVERY surface node in the range to be
    // cited, so a missing one must be merged. turn/start / turn/end are not
    // surface nodes and must stay out of the provenance.
    const events: SessionEvent[] = [
      { type: "turn/start", seq: 7, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 8,
        time: 2,
        data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      { type: "turn/end", seq: 9, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
      {
        type: "user/message",
        seq: 40,
        time: 4,
        data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "user" } },
        surfaceOp: { op: "replace", start: 7, end: 9 },
        sourceEventSeqs: [7, 8],
      } as SessionEvent,
    ];
    normalizeSurfaceReplaceProvenance(events);
    const checkpoint = events[3] as SessionEvent & { sourceEventSeqs?: number[] };
    // surface node @ 8 already cited; nothing new to merge.
    expect(checkpoint.sourceEventSeqs).toEqual([7, 8]);
    // Non-replace events are untouched.
    expect(events[1]).toMatchObject({ seq: 8, surfaceOp: "append" });
  });

  it("normalizeSurfaceReplaceProvenance merges a missing surface node from the range", () => {
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: 10,
        time: 1,
        data: { content: [{ type: "text", text: "old" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      {
        type: "assistant/message",
        seq: 11,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "a",
            role: "assistant",
            content: [{ type: "text", text: "old" }],
            source: { kind: "model", provider: "m", model: "m" },
          },
        },
        surfaceOp: "append",
      } as SessionEvent,
      { type: "turn/end", seq: 12, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
      {
        type: "user/message",
        seq: 20,
        time: 4,
        data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "user" } },
        surfaceOp: { op: "replace", start: 10, end: 12 },
        sourceEventSeqs: [10],
      } as SessionEvent,
    ];
    normalizeSurfaceReplaceProvenance(events);
    const checkpoint = events[3] as SessionEvent & { sourceEventSeqs?: number[] };
    // assistant/message @ 11 is a surface node in the range and was missing.
    expect(checkpoint.sourceEventSeqs).toEqual([10, 11]);
  });

  it("remaps a positional replace surfaceOp through the upstream→persisted seq map", () => {
    // The dense persisted seq must be used for the replacement range, or the
    // surface fold rejects the log ("start seq N not found in surface").
    const row: EventRow = {
      fSequence: 9,
      fOriginalSeq: 30,
      fKind: "tool/result",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 1,
        step: 1,
        message: { source: { kind: "tool", callId: "c" }, content: [] },
      }),
      fSourceEventSeqs: JSON.stringify([2]),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 2, end: 2 }),
    };
    const map = new Map<number, number>([
      [2, 5],
      [30, 9],
    ]);
    const event = rowToEvent(row, map);
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([5]);
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 5, end: 5 });
  });

  it("remaps a compaction/summary shadowedRange through the upstream→persisted seq map", () => {
    // The metering event's shadow-price claim names the replaced range by
    // UPSTREAM seq; it must follow the replace's surfaceOp into dense space or
    // the token-meter fold rejects the log ("token surface: replace ... has no
    // adjacent shadow price").
    const row: EventRow = {
      fSequence: 4056,
      fOriginalSeq: 400_000,
      fKind: "compaction/summary",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 1,
        summary: "…",
        shadowedRange: { start: 15, end: 398_881 },
        shadowedTokenCount: 12_345,
      }),
      fSourceEventSeqs: null,
      fSurfaceOp: null,
    };
    const map = new Map<number, number>([
      [15, 15],
      [398_881, 4048],
      [400_000, 4056],
    ]);
    const event = rowToEvent(row, map);
    expect(event.data).toMatchObject({
      shadowedRange: { start: 15, end: 4048 },
      shadowedTokenCount: 12_345,
    });
  });

  it("remaps a compaction/prune shadowedRange and leaves other data untouched", () => {
    const row: EventRow = {
      fSequence: 3,
      fOriginalSeq: 10,
      fKind: "compaction/prune",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 2,
        shadowedRange: { start: 7, end: 9 },
        shadowedTokenCount: 42,
      }),
      fSourceEventSeqs: null,
      fSurfaceOp: null,
    };
    const event = rowToEvent(
      row,
      new Map<number, number>([
        [7, 1],
        [9, 2],
        [10, 3],
      ]),
    );
    expect(event.data).toMatchObject({
      turn: 2,
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 42,
    });
  });

  it("keeps a compact shadowedRange verbatim without a seq map (no delta filtering)", () => {
    const row: EventRow = {
      fSequence: 3,
      fOriginalSeq: 3,
      fKind: "compaction/summary",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 1,
        shadowedRange: { start: 1, end: 2 },
        shadowedTokenCount: 9,
      }),
      fSourceEventSeqs: null,
      fSurfaceOp: null,
    };
    expect(rowToEvent(row).data).toMatchObject({
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 9,
    });
  });

  it("replays a compact seam so the shadow-price claim matches the replace range", () => {
    // Regression for the reported history-load failure:
    //   token surface: replace at seq 4057 over range 15-4048 has no adjacent
    //   shadow price (armed claim covers 15-398881)
    // The claim (compaction/summary data.shadowedRange, upstream seqs) must land
    // on the SAME dense range as the immediately following replace's surfaceOp.
    const map = new Map<number, number>([
      [15, 15],
      [398_881, 4048],
      [4056, 4056],
      [4057, 4057],
    ]);
    const metering = rowToEvent(
      {
        fSequence: 4056,
        fOriginalSeq: 4056,
        fKind: "compaction/summary",
        fCreatedAt: 1,
        fData: JSON.stringify({
          turn: 1,
          shadowedRange: { start: 15, end: 398_881 },
          shadowedTokenCount: 12_345,
        }),
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
      map,
    );
    const replacement = rowToEvent(
      {
        fSequence: 4057,
        fOriginalSeq: 4057,
        fKind: "assistant/message",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, step: 1, message: { role: "assistant", content: [] } }),
        fSourceEventSeqs: JSON.stringify([15, 398_881]),
        fSurfaceOp: JSON.stringify({ op: "replace", start: 15, end: 398_881 }),
      },
      map,
    );
    const claim = (metering.data as unknown as { shadowedRange: { start: number; end: number } })
      .shadowedRange;
    // The token-meter fold compares claim.start/end with op.start/end for exact
    // equality — an un-remapped claim (15-398881) is exactly the reported failure.
    expect((replacement as SurfaceEvent).surfaceOp).toEqual({
      op: "replace",
      start: 15,
      end: 4048,
    });
    expect(claim).toEqual({ start: 15, end: 4048 });
  });
});

describe("remapSurfaceOp", () => {
  it("leaves append untouched", () => {
    expect(
      remapSurfaceOp("append", () => {
        throw new Error("append must not remap");
      }),
    ).toBe("append");
  });

  it("remaps both ends of a replace range", () => {
    expect(remapSurfaceOp({ op: "replace", start: 2, end: 4 }, (seq) => seq * 10)).toEqual({
      op: "replace",
      start: 20,
      end: 40,
    });
  });
});

describe("remapShadowedRange", () => {
  it("remaps both ends of the shadowed range", () => {
    expect(remapShadowedRange({ start: 15, end: 398_881 }, (seq) => seq - 10)).toEqual({
      start: 5,
      end: 398_871,
    });
  });
});

describe("buildSeqMap", () => {
  it("maps upstream seqs to dense persisted seqs", () => {
    const map = buildSeqMap([
      {
        fSequence: 0,
        fOriginalSeq: 0,
      },
      {
        fSequence: 1,
        fOriginalSeq: 4,
      },
      {
        fSequence: 2,
        fOriginalSeq: 5,
      },
    ]);
    expect(map.get(0)).toBe(0);
    expect(map.get(4)).toBe(1);
    expect(map.get(5)).toBe(2);
  });

  it("keeps the first mapping when upstream seqs overlap across a resume boundary", () => {
    // After resume, the new segment's upstream seqs renumber from the seed
    // boundary and overlap the seed segment's space; a seed-segment provenance
    // reference must resolve to the seed-space row (the first occurrence).
    const map = buildSeqMap([
      {
        fSequence: 0,
        fOriginalSeq: 0,
      },
      {
        fSequence: 1,
        fOriginalSeq: 100,
      },
      {
        fSequence: 2,
        fOriginalSeq: 101,
      },
      {
        fSequence: 3,
        fOriginalSeq: 3,
      },
      {
        fSequence: 4,
        fOriginalSeq: 100,
      },
      {
        fSequence: 5,
        fOriginalSeq: 102,
      },
    ]);
    expect(map.get(100)).toBe(1);
    expect(map.get(101)).toBe(2);
    expect(map.get(102)).toBe(5);
  });
});

describe("SessionPersistenceSqlite: durability and crash semantics", () => {
  it("rejects a stored v0 log containing a legacy request/header-delta event", async () => {
    const path = await freshDbPath();
    const m = meta("legacy-header-delta", "/legacy");
    const db = openDatabase(path, "wal");
    db.prepare(`
      INSERT INTO t_sessions
        (f_session_id, f_head_event_id, f_head_sequence, f_version, f_created_at, f_cwd,
         f_parent_session, f_seed_length, f_origin, f_delegation_depth, f_incarnation, f_revision)
      VALUES (?, '', -1, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1)
    `).run(m.id, m.version, m.createdAt, m.cwd ?? null, "legacy-header-delta");
    let parent = "";
    insertEventRow(db, m.id, 0, "turn/start", { turn: 1 }, parent);
    parent = insertEventRow(
      db,
      m.id,
      1,
      "request/header-delta",
      { config: { model: "legacy" } },
      parent,
    );
    insertEventRow(db, m.id, 2, "turn/end", { turn: 1, reason: { kind: "completed" } }, parent);
    db.close();

    const mounted = await backend(path);
    await expect(mounted.ctx.sessionPersistence.load(m.id)).rejects.toThrow(
      /unsupported legacy request\/header-delta event at seq 1/,
    );
    await mounted.dispose();
  });

  it("has no independent per-session log location", async () => {
    const { ctx, dispose } = await backend();
    expect(ctx.sessionPersistence.locate(meta("sqlite-location"))).toBeUndefined();
    await dispose();
  });

  it("an interrupted turn (rows after the last turn/end) is PRESERVED and closed during load", async () => {
    const path = await freshDbPath();
    const m = meta("crash");
    // Run 1: persist a complete turn, then a half-written second turn (no turn/end).
    const ctx1 = new Context();
    await ctx1.plugin(EmptySettings);
    await ctx1.plugin(SessionStore);
    const fiber1 = await ctx1.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    await ctx1.sessionPersistence.create(m);
    await ctx1.sessionPersistence.append(m.id, oneTurnLog());
    await ctx1.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: 6,
        time: 7,
        data: { turn: 2 },
      },
      { type: "step/start", seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ]);
    await fiber1.dispose();

    // Run 2: load PRESERVES the interrupted turn's real events (a turn can be huge
    // — never truncated) and closes the orphaned turn with synthetic boundary
    // events: step/end (the step was open) then turn/end {interrupted}.
    const ctx2 = new Context();
    await ctx2.plugin(EmptySettings);
    await ctx2.plugin(SessionStore);
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    const loaded = await ctx2.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end", // turn 1
      "turn/start",
      "step/start",
      "step/end",
      "turn/end", // turn 2: real events + synthetic closers
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const last = loaded.events.at(-1)!;
    expect(last.type === "turn/end" && last.data.reason).toEqual({ kind: "interrupted" });

    // load durably closed the turn, so the next append continues at the balanced
    // length (seq 10) and a reload round-trips identically.
    await ctx2.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: 10,
        time: 9,
        data: { turn: 3 },
      },
      { type: "turn/end", seq: 11, time: 10, data: { turn: 3, reason: { kind: "completed" } } },
    ]);
    const reloaded = await ctx2.sessionPersistence.load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await fiber2.dispose();
  });

  it("load() durably closes the interrupted turn: the synthetic closers are on disk after load", async () => {
    const path = await freshDbPath();
    const m = meta("load-closes");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()); // seqs 0..5
    await b1.dispose();
    // Hand-write an interrupted turn (turn/start seq 6, no turn/end).
    const db = openDatabase(path, "wal");
    const head = db
      .prepare("SELECT f_head_event_id FROM t_sessions WHERE f_session_id = ?")
      .get(m.id) as { f_head_event_id: string };
    insertEventRow(db, m.id, 6, "turn/start", { turn: 2 }, head.f_head_event_id);
    db.close();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    // turn 2's real turn/start (seq 6) is preserved + a synthetic turn/end (seq 7).
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loaded.events.at(-1)!.type).toBe("turn/end");
    // load() is mutating: the synthetic turn/end MUST be on disk so the stored log
    // is balanced and the cursor is truthful (contract: load closes, not defers).
    const probe = openDatabase(path, "wal");
    const stored = probe
      .prepare(`
      SELECT se.f_sequence, e.f_kind FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as { f_sequence: number; f_kind: string }[];
    probe.close();
    expect(stored.map((r) => r.f_sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(stored.at(-1)!.f_kind).toBe("turn/end");
    await b2.dispose();
  });

  it("rejects opening a database whose schema version is not the current build (newer OR older)", async () => {
    const path = await freshDbPath();
    openDatabase(path, "wal").close(); // stamp user_version = SCHEMA_VERSION
    const dbNewer = openDatabase(path, "wal");
    dbNewer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    dbNewer.close();
    expect(() => openDatabase(path, "wal")).toThrow(/incompatible with this build/);

    // The immediately preceding layout lacks the required store identity and is
    // rejected rather than migrated (unreleased software, no backward-compat).
    // Version 0 means "unversioned", so probe an explicit non-current version
    // (SCHEMA_VERSION - 1 is 0 at SCHEMA_VERSION 1).
    const olderPath = await freshDbPath();
    openDatabase(olderPath, "wal").close();
    const dbOlder = openDatabase(olderPath, "wal");
    dbOlder.exec("PRAGMA user_version = 123");
    dbOlder.close();
    expect(() => openDatabase(olderPath, "wal")).toThrow(/incompatible with this build/);
  });

  it("rejects a table-backed unversioned database before stamping or changing journal mode", async () => {
    const path = await freshDbPath();
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE t_sessions (id TEXT PRIMARY KEY)");
    legacy.close();

    expect(() => openDatabase(path, "wal")).toThrow(/unversioned schema or application identity/);

    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(unchanged.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(
      unchanged
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 't_sessions'")
        .get(),
    ).toEqual({ name: "t_sessions" });
    unchanged.close();
  });

  it("rejects view-only and foreign-application unversioned databases without mutation", async () => {
    const viewPath = await freshDbPath();
    const viewOnly = new DatabaseSync(viewPath);
    viewOnly.exec("CREATE VIEW foreign_view AS SELECT 1 AS value");
    viewOnly.close();

    expect(() => openDatabase(viewPath, "wal")).toThrow(
      /unversioned schema or application identity/,
    );
    const unchangedView = new DatabaseSync(viewPath);
    expect(unchangedView.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(
      unchangedView.prepare("SELECT type FROM sqlite_schema WHERE name = 'foreign_view'").get(),
    ).toEqual({ type: "view" });
    unchangedView.close();

    const applicationPath = await freshDbPath();
    const foreignApplication = new DatabaseSync(applicationPath);
    foreignApplication.exec("PRAGMA application_id = 12345");
    foreignApplication.close();

    expect(() => openDatabase(applicationPath, "wal")).toThrow(
      /unversioned schema or application identity/,
    );
    const unchangedApplication = new DatabaseSync(applicationPath);
    expect(unchangedApplication.prepare("PRAGMA application_id").get()).toEqual({
      application_id: 12345,
    });
    expect(unchangedApplication.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(unchangedApplication.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
    unchangedApplication.close();
  });

  it("rejects a current-version database with a foreign application identity", async () => {
    const path = await freshDbPath();
    const foreign = new DatabaseSync(path);
    foreign.exec("PRAGMA application_id = 12345");
    foreign.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    foreign.close();

    expect(() => openDatabase(path, "wal")).toThrow(/has application id 12345/);

    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare("PRAGMA application_id").get()).toEqual({ application_id: 12345 });
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({
      user_version: SCHEMA_VERSION,
    });
    expect(unchanged.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    unchanged.close();
  });

  it("rolls back schema objects and identity stamps when initialization fails", async () => {
    const path = await freshDbPath();
    const conflicting = new DatabaseSync(path);
    conflicting.exec(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`);
    conflicting.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    conflicting.exec(
      "CREATE VIEW t_persistence_state AS SELECT 1 AS f_singleton, 'foreign' AS f_store_id",
    );
    conflicting.close();

    expect(() => openDatabase(path, "wal")).toThrow();

    const unchanged = new DatabaseSync(path);
    expect(
      unchanged.prepare("SELECT type FROM sqlite_schema WHERE name = 't_persistence_state'").get(),
    ).toEqual({ type: "view" });
    expect(
      unchanged.prepare("SELECT type FROM sqlite_schema WHERE name = 't_sessions'").get(),
    ).toBeUndefined();
    expect(
      unchanged.prepare("SELECT type FROM sqlite_schema WHERE name = 't_events'").get(),
    ).toBeUndefined();
    expect(
      unchanged.prepare("SELECT type FROM sqlite_schema WHERE name = 't_session_events'").get(),
    ).toBeUndefined();
    expect(unchanged.prepare("PRAGMA application_id").get()).toEqual({
      application_id: SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
    });
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({
      user_version: SCHEMA_VERSION,
    });
    expect(unchanged.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    unchanged.close();
  });

  it("stamps the persistence application identity with the schema version", async () => {
    const path = await freshDbPath();
    openDatabase(path, "wal").close();

    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA application_id").get()).toEqual({
      application_id: SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
    });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    db.close();
  });

  it("a corrupt-JSON row in the uncommitted tail is discarded on load, not unloadable", async () => {
    const path = await freshDbPath();
    const m = meta("corrupt-tail");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()); // committed: seqs 0..5
    await b1.dispose();

    const db = openDatabase(path, "wal");
    const head = db
      .prepare("SELECT f_head_event_id FROM t_sessions WHERE f_session_id = ?")
      .get(m.id) as { f_head_event_id: string };
    const eventId = randomUUID();
    db.prepare(`
      INSERT INTO t_events
        (f_event_id, f_parent_id, f_kind, f_role, f_name, f_action_id, f_encoding,
         f_data, f_created_at, f_original_seq, f_source_event_seqs, f_surface_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      head.f_head_event_id,
      "turn/start",
      "turn",
      "",
      "",
      "json",
      "{not valid json",
      7,
      6,
      null,
      null,
    );
    db.prepare(
      "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence) VALUES (?, ?, ?)",
    ).run(m.id, eventId, 6);
    db.close();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(loaded.events).toEqual(oneTurnLog()); // torn tail discarded, committed intact (turn 1 already balanced → no closers)
    // load physically deleted the corrupt tail row, so a fresh append continues.
    await b2.ctx.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: 6,
        time: 8,
        data: { turn: 2 },
      },
      { type: "turn/end", seq: 7, time: 9, data: { turn: 2, reason: { kind: "completed" } } },
    ]);
    const reloaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await b2.dispose();
  });

  it("append rolls back the whole batch on a mid-batch seq collision (transaction)", async () => {
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
    const m = meta("rollback");
    await ctx.sessionPersistence.create(m);
    await ctx.sessionPersistence.append(m.id, oneTurnLog()); // seqs 0..5

    // A batch that re-states an already-stored seq must be rejected and leave
    // the stored log unchanged (the UNIQUE (session_id, seq) constraint fires
    // inside the transaction → ROLLBACK).
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).rejects.toThrow();
    const loaded = await ctx.sessionPersistence.load(m.id);
    expect(loaded.events).toEqual(oneTurnLog()); // unchanged
    await fiber.dispose();
  });

  it("persists across separate backend instances over the same file", async () => {
    const path = await freshDbPath();
    const m = meta("persist", "/proj");
    const ctx1 = new Context();
    await ctx1.plugin(EmptySettings);
    await ctx1.plugin(SessionStore);
    const fiber1 = await ctx1.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    await ctx1.sessionPersistence.create(m);
    await ctx1.sessionPersistence.append(m.id, oneTurnLog());
    await fiber1.dispose();

    const ctx2 = new Context();
    await ctx2.plugin(EmptySettings);
    await ctx2.plugin(SessionStore);
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    expect((await ctx2.sessionPersistence.list()).map((x) => x.id)).toContain(m.id);
    const loaded = await ctx2.sessionPersistence.load(m.id);
    expect(loaded.meta).toMatchObject({ id: m.id, cwd: "/proj" });
    expect(loaded.events).toEqual(oneTurnLog());
    await fiber2.dispose();
  });

  it("source-qualifies revisions across stores while preserving same-file reopen identity", async () => {
    const pathA = await freshDbPath();
    const pathB = await freshDbPath();
    const m = meta("revision-source");
    const a = await backend(pathA);
    await a.ctx.sessionPersistence.create(m);
    await a.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const revisionA = (await a.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    await a.dispose();

    const probeA = openDatabase(pathA, "wal");
    const storeIdA = (
      probeA.prepare("SELECT f_store_id FROM t_persistence_state WHERE f_singleton = 1").get() as {
        f_store_id: string;
      }
    ).f_store_id;
    probeA.close();

    const aliasA = `${pathA}.alias`;
    await symlink(pathA, aliasA);
    const reopenedA = await backend(aliasA);
    expect((await reopenedA.ctx.sessionPersistence.listSnapshots())[0]?.revision).toBe(revisionA);
    await reopenedA.dispose();

    const b = await backend(pathB);
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const revisionB = (await b.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    const probeB = openDatabase(pathB, "wal");
    const storeIdB = (
      probeB.prepare("SELECT f_store_id FROM t_persistence_state WHERE f_singleton = 1").get() as {
        f_store_id: string;
      }
    ).f_store_id;
    probeB.close();
    expect(storeIdB).not.toBe(storeIdA);
    expect(revisionB).not.toBe(revisionA);
    expect(String(revisionA)).toMatch(/:revision:1$/);
    expect(String(revisionB)).toMatch(/:revision:1$/);
    await b.dispose();
  });

  it("changes revisions when a deleted session id is materialized again in the same database", async () => {
    const path = await freshDbPath();
    const m = meta("recreated-revision");
    const first = await backend(path);
    await first.ctx.sessionPersistence.create(m);
    await first.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const before = (await first.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    await first.dispose();

    const cleanup = openDatabase(path, "wal");
    cleanup.prepare("DELETE FROM t_sessions WHERE f_session_id = ?").run(m.id);
    cleanup.close();

    const second = await backend(path);
    await second.ctx.sessionPersistence.create(m);
    await second.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const after = (await second.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    expect(after).not.toBe(before);
    expect(String(before)).toMatch(/:revision:1$/);
    expect(String(after)).toMatch(/:revision:1$/);
    await second.dispose();
  });

  it("keeps the revision stable for an empty repair hook", async () => {
    const b = await backend();
    const m = meta("empty-repair");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const before = await b.ctx.sessionPersistence.listSnapshots();
    await (b.ctx.sessionPersistence as SessionPersistenceSqlite).commitRepair(m, undefined, []);
    expect(await b.ctx.sessionPersistence.listSnapshots()).toEqual(before);
    await b.dispose();
  });

  it("applies the configured busy timeout to every opened connection (default 5000ms)", async () => {
    const path = await freshDbPath();
    // The backend opens one connection; the same pragma is asserted per handle
    // (busy_timeout is connection-scoped, never persisted in the database).
    const immediate = openDatabase(path, "wal", 0);
    expect(immediate.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    immediate.close();
    const custom = openDatabase(path, "wal", 321);
    expect(custom.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 321 });
    custom.close();
    const defaulted = openDatabase(path, "wal");
    expect(defaulted.prepare("PRAGMA busy_timeout").get()).toEqual({
      timeout: DEFAULT_BUSY_TIMEOUT_MS,
    });
    defaulted.close();
  });

  it("busyTimeout config wires from the plugin into the database connection", async () => {
    const path = await freshDbPath();
    // Loading the plugin with a custom busyTimeout proves the config key is
    // accepted and passed through the open path (the connection itself is
    // private; the value is asserted via a second connection above).
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path,
      busyTimeout: 0,
    });
    await ctx.sessionPersistence.list();
    await fiber.dispose();
  });
});

/** A one-turn log with a delta stream between step/start and assistant/message. */
function chunkedTurnLog(): SessionEvent[] {
  return [
    {
      type: "turn/start",
      seq: 0,
      time: 1,
      data: { turn: 1 },
    },
    {
      type: "user/message",
      seq: 1,
      time: 2,
      data: createUserMessage({
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    { type: "step/start", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: "assistant/chunk",
      seq: 3,
      time: 4,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
    },
    {
      type: "assistant/chunk",
      seq: 4,
      time: 5,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
    },
    {
      type: "assistant/message",
      seq: 5,
      time: 6,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "model", provider: "mock", model: "mock" },
        }),
      },
      surfaceOp: "append",
      sourceEventSeqs: [1],
    },
    { type: "step/end", seq: 6, time: 7, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 7, time: 8, data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

/**
 * Mirror of `@deepseek-ai/dsh-token-meter`'s `foldSurfaceProjection` — the
 * package is not resolvable from the configured registry, so the compact-seam
 * regression test reproduces its O(1) shadow-price fold contract inline. The
 * estimator is a constant stand-in; only the claim protocol is under test
 * (a `compaction/summary` / `compaction/prune` arms a claim for its exact
 * `shadowedRange`, the immediately following surface `replace` must consume
 * that exact range, and a mismatch fails loud with the reported message).
 */
function mirrorSurfaceTokensFold(
  claim: { start: number; end: number; tokens: number } | undefined,
  event: SessionEvent,
): {
  deltaTokens: number;
  claim: { start: number; end: number; tokens: number } | undefined;
} {
  const type = (event as { type: string }).type;
  if (type === "compaction/summary" || type === "compaction/prune") {
    const data = event.data as unknown as {
      shadowedRange: { start: number; end: number };
      shadowedTokenCount: number;
    };
    return {
      deltaTokens: 0,
      claim: {
        start: data.shadowedRange.start,
        end: data.shadowedRange.end,
        tokens: data.shadowedTokenCount,
      },
    };
  }
  const op = (event as unknown as Partial<SurfaceEvent>).surfaceOp;
  if (op === undefined || op === "append") return { deltaTokens: 1, claim: undefined };
  if (claim === undefined) return { deltaTokens: 0, claim: undefined };
  if (claim.start !== op.start || claim.end !== op.end) {
    throw new Error(
      `token surface: replace at seq ${event.seq} over range ${op.start}-${op.end} has no adjacent shadow price` +
        ` (armed claim covers ${claim.start}-${claim.end})`,
    );
  }
  return { deltaTokens: 1 - claim.tokens, claim: undefined };
}

describe("SessionPersistenceSqlite: delta filtering (ephemeral chunks never persisted)", () => {
  it("drops delta events at write time and re-numbers surviving events densely", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-drop");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());

    // No delta row exists: 6 persisted rows with DENSE persisted seqs and the
    // upstream seqs recorded in f_original_seq.
    const probe = openDatabase(path, "wal");
    const rows = probe
      .prepare(`
      SELECT se.f_sequence, e.f_original_seq, e.f_kind, e.f_role FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as {
      f_sequence: number;
      f_original_seq: number;
      f_kind: string;
      f_role: string;
    }[];
    expect(rows).toEqual([
      { f_sequence: 0, f_original_seq: 0, f_kind: "turn/start", f_role: "turn" },
      { f_sequence: 1, f_original_seq: 1, f_kind: "user/message", f_role: "user" },
      { f_sequence: 2, f_original_seq: 2, f_kind: "step/start", f_role: "turn" },
      { f_sequence: 3, f_original_seq: 5, f_kind: "assistant/message", f_role: "model" },
      { f_sequence: 4, f_original_seq: 6, f_kind: "step/end", f_role: "turn" },
      { f_sequence: 5, f_original_seq: 7, f_kind: "turn/end", f_role: "turn" },
    ]);
    // The head cursor tracks the dense persisted seq.
    expect(
      probe.prepare("SELECT f_head_sequence FROM t_sessions WHERE f_session_id = ?").get(m.id),
    ).toEqual({ f_head_sequence: 5 });
    probe.close();

    // load returns the dense log without any delta event.
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b.dispose();
  });

  it("a batch containing only delta events is a no-op (no materialization, no revision)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-only");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "assistant/chunk",
        seq: 0,
        time: 1,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "x" } },
      },
    ]);
    // Nothing was materialized: the session is absent from list/snapshots.
    expect(await b.ctx.sessionPersistence.list()).toEqual([]);
    expect(await b.ctx.sessionPersistence.listSnapshots()).toEqual([]);
    // The session remains appendable. The dropped delta occupied upstream seq 0,
    // so the next batch starts at upstream seq 1 and lands at dense seq 0.
    await b.ctx.sessionPersistence.append(
      m.id,
      oneTurnLog().map((e) => ({ ...e, seq: e.seq + 1 })),
    );
    expect(await b.ctx.sessionPersistence.list()).toHaveLength(1);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b.dispose();
  });

  it("prunes assistant/message sourceEventSeqs references to dropped deltas (same batch)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-prune-same");
    await b.ctx.sessionPersistence.create(m);
    // The assistant/message references the chunk events (upstream seqs 3,4),
    // which are dropped at write time — the reference must not be persisted.
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: 0,
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: 2,
        time: 3,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: 4,
        time: 5,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
        sourceEventSeqs: [2, 3],
      },
      { type: "step/end", seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: "turn/end", seq: 6, time: 7, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    // The dropped-delta references are gone from the stored row.
    const probe = openDatabase(path, "wal");
    const row = probe
      .prepare(
        "SELECT e.f_source_event_seqs AS ses FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id WHERE se.f_session_id = ? AND e.f_kind = 'assistant/message'",
      )
      .get(m.id) as { ses: string | null };
    expect(row.ses).toBeNull();
    probe.close();
    // Reload replays cleanly: the dense assistant/message carries no provenance.
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(2); // dense
    expect((assistant as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    await b.dispose();
  });

  it("prunes assistant/message sourceEventSeqs references to dropped deltas across batches", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-prune-cross");
    await b.ctx.sessionPersistence.create(m);
    // Batch 1: only deltas (dropped, no materialization).
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "assistant/chunk",
        seq: 0,
        time: 1,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: 1,
        time: 2,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
    ]);
    // Batch 2: the message referencing batch 1's dropped seqs.
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "assistant/message",
        seq: 2,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
        sourceEventSeqs: [0, 1],
      },
      { type: "turn/end", seq: 3, time: 4, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    const probe = openDatabase(path, "wal");
    const row = probe
      .prepare(
        "SELECT e.f_source_event_seqs AS ses FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id WHERE se.f_session_id = ? AND e.f_kind = 'assistant/message'",
      )
      .get(m.id) as { ses: string | null };
    expect(row.ses).toBeNull();
    probe.close();
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(0); // dense
    expect((assistant as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    await b.dispose();
  });

  it("keeps sourceEventSeqs references to persisted events while pruning dropped-delta refs", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-prune-mixed");
    await b.ctx.sessionPersistence.create(m);
    // The user/message (upstream seq 1) survives, the chunks (seqs 3,4) do not;
    // the message references all three — only the survived reference persists.
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: 0,
        time: 1,
        data: { turn: 1 },
      },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: 4,
        time: 5,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: 5,
        time: 6,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
        sourceEventSeqs: [1, 3, 4],
      },
      { type: "step/end", seq: 6, time: 7, data: { turn: 1, step: 1 } },
      { type: "turn/end", seq: 7, time: 8, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    const probe = openDatabase(path, "wal");
    const row = probe
      .prepare(
        "SELECT e.f_source_event_seqs AS ses FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id WHERE se.f_session_id = ? AND e.f_kind = 'assistant/message'",
      )
      .get(m.id) as { ses: string | null };
    // Upstream 1 is persisted (dense 1); 3,4 are dropped. The stored list keeps
    // only the resolvable reference.
    expect(JSON.parse(row.ses!)).toEqual([1]);
    probe.close();
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect((assistant as SurfaceEvent).sourceEventSeqs).toEqual([1]);
    await b.dispose();
  });

  it("reload + append continues from the dense persisted seq (re-created seq space)", async () => {
    const path = await freshDbPath();
    const m = meta("delta-reload");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, chunkedTurnLog());
    await b1.dispose();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    // Re-create the live session from the loaded (dense) log: the seed is
    // contiguous, so the store adopts the persisted prefix and the next append
    // continues at the dense cursor (seq 6).
    const session = b2.ctx.sessions.create(SessionId(m.id), { seed: loaded.events });
    session.append("turn/start", {
      turn: 2,
    });
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "again" }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    await b2.ctx.sessions.flush(session);

    const reloaded = await b2.ctx.sessionPersistence.load(m.id);
    // The re-created session marks its seed with session/end-seed (seq 6), then
    // the live turn follows — all in the dense seq space.
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(reloaded.events.map((e) => e.type).slice(6)).toEqual([
      "session/end-seed",
      "turn/start",
      "user/message",
      "turn/end",
    ]);
    await b2.dispose();
  });

  it("remaps sourceEventSeqs provenance to the dense seq space on read", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-provenance");
    await b.ctx.sessionPersistence.create(m);
    // user/message seq 0; the assistant/message after the delta stream carries
    // sourceEventSeqs [1] (the user message's UPSTREAM seq 1).
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());

    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(3); // dense
    expect((assistant as SurfaceEvent).sourceEventSeqs).toEqual([1]); // upstream 1 == dense 1 here
    await b.dispose();
  });

  it("readFrom returns the dense suffix with provenance remapped", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-readfrom");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());
    const suffix = await b.ctx.sessionPersistence.readFrom(m.id, 3);
    expect(suffix.events.map((e) => e.type)).toEqual(["assistant/message", "step/end", "turn/end"]);
    expect(suffix.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    await b.dispose();
  });

  it("an interrupted delta-stream turn is closed with synthetic closers on load", async () => {
    const path = await freshDbPath();
    const m = meta("delta-crash");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    // Turn 1 committed (0..5 dense), then a crashed turn 2 whose only persisted
    // events are a turn/start (dense 6); the delta stream is dropped entirely.
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog());
    await b1.ctx.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: 6,
        time: 7,
        data: { turn: 2 },
      },
      {
        type: "assistant/chunk",
        seq: 7,
        time: 8,
        data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "gone" } },
      },
      {
        type: "assistant/chunk",
        seq: 8,
        time: 9,
        data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "gone" } },
      },
    ]);
    await b1.dispose();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    // turn/start (dense 6) preserved + synthetic turn/end {interrupted} (dense 7).
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end",
      "turn/start",
      "turn/end",
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loaded.events.at(-1)!.type === "turn/end" && loaded.events.at(-1)!.data).toMatchObject({
      reason: { kind: "interrupted" },
    });
    await b2.dispose();
  });

  it("drops ignorable events at write time and re-numbers surviving events densely", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("ignorable-drop");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      // Unknown plugin event marked ignorable: dropped, never persisted.
      {
        type: "plugin/test",
        seq: 1,
        time: 2,
        data: null,
        ignorable: true,
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: 2,
        time: 3,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "turn/end", seq: 3, time: 4, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    // The ignorable event is absent from storage; survivors are dense.
    const probe = openDatabase(path, "wal");
    const rows = probe
      .prepare(`
      SELECT se.f_sequence, e.f_original_seq, e.f_kind FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as { f_sequence: number; f_original_seq: number; f_kind: string }[];
    expect(rows).toEqual([
      { f_sequence: 0, f_original_seq: 0, f_kind: "turn/start" },
      { f_sequence: 1, f_original_seq: 2, f_kind: "user/message" },
      { f_sequence: 2, f_original_seq: 3, f_kind: "turn/end" },
    ]);
    probe.close();
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.type)).toEqual(["turn/start", "user/message", "turn/end"]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    await b.dispose();
  });

  it("a batch containing only ignorable events is a no-op (no materialization, no revision)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("ignorable-only");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "plugin/test",
        seq: 0,
        time: 1,
        data: null,
        ignorable: true,
      } as unknown as SessionEvent,
    ]);
    // Nothing was materialized: the session is absent from list/snapshots.
    expect(await b.ctx.sessionPersistence.list()).toEqual([]);
    expect(await b.ctx.sessionPersistence.listSnapshots()).toEqual([]);
    // The session remains appendable; the dropped event occupied upstream seq 0,
    // so the next batch starts at upstream seq 1 and lands at dense seq 0.
    await b.ctx.sessionPersistence.append(
      m.id,
      oneTurnLog().map((e) => ({ ...e, seq: e.seq + 1 })),
    );
    expect(await b.ctx.sessionPersistence.list()).toHaveLength(1);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b.dispose();
  });

  it("prunes assistant/message sourceEventSeqs references to dropped ignorable events", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("ignorable-prune");
    await b.ctx.sessionPersistence.create(m);
    // The assistant/message references the ignorable plugin event (upstream
    // seq 1), which is dropped at write time — the reference must not persist.
    await b.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "plugin/test",
        seq: 1,
        time: 2,
        data: null,
        ignorable: true,
      } as unknown as SessionEvent,
      {
        type: "assistant/message",
        seq: 2,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
        sourceEventSeqs: [1],
      },
      { type: "turn/end", seq: 3, time: 4, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    const probe = openDatabase(path, "wal");
    const row = probe
      .prepare(
        "SELECT e.f_source_event_seqs AS ses FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id WHERE se.f_session_id = ? AND e.f_kind = 'assistant/message'",
      )
      .get(m.id) as { ses: string | null };
    expect(row.ses).toBeNull();
    probe.close();
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(1); // dense
    expect((assistant as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    await b.dispose();
  });

  it("replays a compact seam so the shadow-price claim matches the dense replace range", async () => {
    // Regression for the reported history-load failure:
    //   token surface: replace at seq 4057 over range 15-4048 has no adjacent
    //   shadow price (armed claim covers 15-398881)
    // Turn 1 establishes two surface nodes with chunk deltas dropped at write
    // time; turn 2 compacts them — compaction/summary meters the shadowed range
    // (UPSTREAM seqs 1-5) and the adjacent assistant/message replaces it. After
    // the dense renumbering, both the claim and the replace range must land on
    // the same DENSE seqs for the token-meter fold to consume the claim.
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("compact-seam");
    await b.ctx.sessionPersistence.create(m);
    const log = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: 4,
        time: 5,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: 5,
        time: 6,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
        sourceEventSeqs: [3, 4],
      },
      { type: "step/end", seq: 6, time: 7, data: { turn: 1, step: 1 } },
      { type: "turn/end", seq: 7, time: 8, data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", seq: 8, time: 9, data: { turn: 2 } },
      { type: "step/start", seq: 9, time: 10, data: { turn: 2, step: 1 } },
      { type: "compaction/start", seq: 10, time: 11, data: { turn: 2 } },
      {
        type: "compaction/summary",
        seq: 11,
        time: 12,
        data: {
          turn: 2,
          summary: "compacted",
          shadowedRange: { start: 1, end: 5 },
          shadowedTokenCount: 100,
        },
      },
      {
        type: "assistant/message",
        seq: 12,
        time: 13,
        data: {
          turn: 2,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "compacted" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: { op: "replace", start: 1, end: 5 },
        sourceEventSeqs: [1, 5],
      },
      { type: "step/end", seq: 13, time: 14, data: { turn: 2, step: 1 } },
      { type: "turn/end", seq: 14, time: 15, data: { turn: 2, reason: { kind: "completed" } } },
    ] as unknown as SessionEvent[];
    await b.ctx.sessionPersistence.append(m.id, log);

    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const metering = loaded.events.find(
      (e) => (e as { type: string }).type === "compaction/summary",
    );
    const replacement = loaded.events.find((e) => e.type === "assistant/message" && e.seq > 5);
    expect(metering).toBeDefined();
    expect(replacement).toBeDefined();
    // Both the claim and the replacement range land on DENSE seqs.
    const claimRange = (
      metering!.data as unknown as { shadowedRange: { start: number; end: number } }
    ).shadowedRange;
    const op = (replacement as SurfaceEvent).surfaceOp;
    expect(op).toEqual({ op: "replace", start: 1, end: 3 });
    expect((replacement as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);
    expect(claimRange).toEqual({ start: 1, end: 3 });

    // The token-meter fold must consume the armed claim instead of throwing
    // the reported "has no adjacent shadow price" error.
    let claim: { start: number; end: number; tokens: number } | undefined;
    let armed = 0;
    let consumed = 0;
    expect(() => {
      for (const event of loaded.events) {
        if ((event as { type: string }).type === "compaction/summary") armed += 1;
        const fold = mirrorSurfaceTokensFold(claim, event);
        if (claim !== undefined && fold.claim === undefined) consumed += 1;
        claim = fold.claim;
      }
    }).not.toThrow();
    expect(armed).toBe(1);
    expect(consumed).toBe(1);
    await b.dispose();
  });

  it("cleanseSession rewrites upstream-coordinate provenance into dense space", async () => {
    // append 时事件 seq 是上游坐标,replace 的 sourceEventSeqs 引用上游 seq
    // (delta 被过滤后稠密重编号)——存储即「旧数据」样式。清洗把它一次性
    // 重写为稠密坐标,之后读取无需再对齐。
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("cleanse-me");
    await b.ctx.sessionPersistence.create(m);
    const log = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: 4,
        time: 5,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: 5,
        time: 6,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
      },
      { type: "step/end", seq: 6, time: 7, data: { turn: 1, step: 1 } },
      { type: "turn/end", seq: 7, time: 8, data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", seq: 8, time: 9, data: { turn: 2 } },
      { type: "step/start", seq: 9, time: 10, data: { turn: 2, step: 1 } },
      {
        type: "assistant/message",
        seq: 10,
        time: 11,
        data: {
          turn: 2,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "compacted" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: { op: "replace", start: 1, end: 5 },
        sourceEventSeqs: [1, 5],
      },
      { type: "step/end", seq: 11, time: 12, data: { turn: 2, step: 1 } },
      { type: "turn/end", seq: 12, time: 13, data: { turn: 2, reason: { kind: "completed" } } },
    ] as unknown as SessionEvent[];
    await b.ctx.sessionPersistence.append(m.id, log);

    const persistence = b.ctx.sessionPersistence as SessionPersistenceSqlite;
    const backendApi = persistence.internals().backend;
    // 存储是上游坐标:replace [1,5] 与 sourceEventSeqs [1,5] 原样落库。
    const rowBefore = (await backendApi.getEventRows(m.id)).find((r) => r.fSequence === 8)!;
    expect(rowBefore.fSourceEventSeqs).toBe("[1,5]");

    // 读取时启发式已给出稠密视图。
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const replacement = loaded.events.find((e) => e.type === "assistant/message" && e.seq === 8)!;
    expect((replacement as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);

    // 清洗:重写为稠密坐标。
    const { changed } = await persistence.cleanseSession(m.id);
    expect(changed).toBeGreaterThan(0);

    const rowAfter = (await backendApi.getEventRows(m.id)).find((r) => r.fSequence === 8)!;
    expect(rowAfter.fSourceEventSeqs).toBe("[1,3]");
    expect(rowAfter.fSurfaceOp).toBe(JSON.stringify({ op: "replace", start: 1, end: 3 }));

    // 清洗后仍可正常加载,且无需启发式即得稠密视图。
    const reloaded = await b.ctx.sessionPersistence.load(m.id);
    const replacementAfter = reloaded.events.find(
      (e) => e.type === "assistant/message" && e.seq === 8,
    )!;
    expect((replacementAfter as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);
    await b.dispose();
  });
});

describe("SessionPersistenceSqlite: edge cases", () => {
  it("rejects and closes a current-schema database with an invalid store identity", async () => {
    const path = await freshDbPath();
    const db = openDatabase(path, "wal");
    db.exec("UPDATE t_persistence_state SET f_store_id = '' WHERE f_singleton = 1");
    db.close();

    const b = await backend(path);
    await expect(b.ctx.sessionPersistence.listSnapshots()).rejects.toThrow(
      /no valid store identity/,
    );
    await expect(b.dispose()).resolves.toBeUndefined();
  });

  it("creates a new database and WAL sidecars with owner-only modes without changing its parent mode", async () => {
    if (process.platform === "win32") return;
    const path = await freshDbPath();
    const dir = dirname(path);
    await chmod(dir, 0o755);

    const b = await backend(path);
    await b.ctx.sessionPersistence.list();

    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600);
    await b.dispose();
  });

  it("creates a persistent rollback journal with owner-only mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path,
      journalMode: "persist",
    });
    const m = meta("persist-permissions");

    await ctx.sessionPersistence.create(m);
    await ctx.sessionPersistence.append(m.id, oneTurnLog());

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-journal`)).mode & 0o777).toBe(0o600);
    await fiber.dispose();
  });

  it("preserves the mode of an existing database file", async () => {
    if (process.platform === "win32") return;
    const path = await freshDbPath();
    await writeFile(path, "", { mode: 0o644 });
    await chmod(path, 0o644);

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path,
      journalMode: "delete",
    });
    await ctx.sessionPersistence.list();

    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await fiber.dispose();
  });

  it("journalMode config reaches the database (default wal, rollback modes selectable)", async () => {
    const walPath = await freshDbPath();
    const bWal = await backend(walPath);
    await bWal.ctx.sessionPersistence.create(meta("jm-wal"));
    const probe = openDatabase(walPath, "wal");
    expect(
      (probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    probe.close();
    await bWal.dispose();

    const deletePath = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path: deletePath,
      journalMode: "delete",
    });
    await ctx.sessionPersistence.create(meta("jm-delete"));
    const db = openDatabase(deletePath, "delete");
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "delete",
    );
    db.close();
    expect(existsSync(`${deletePath}-wal`)).toBe(false);
    await fiber.dispose();
  });

  it("HMR: a DIFFERENT session colliding with a materialized on-disk id is rejected", async () => {
    const path = await freshDbPath();
    // Instance 1 materializes a session and disposes.
    const b1 = await backend(path);
    const s1 = b1.ctx.sessions.create(SessionId("hmr-collide"));
    appendLog(s1, oneTurnLog());
    await b1.ctx.sessions.flush(s1);
    await b1.dispose();

    // A fresh context with an UNRELATED live session reusing the id meets a
    // materialized row that is NOT a prefix of its events → reject.
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    let session!: Session;
    await ctx.plugin(
      Object.assign(
        (inner: Context) => {
          session = inner.sessions.create(SessionId("hmr-collide"));
        },
        { inject: ["sessions"] },
      ),
    );
    session.append("turn/start", {
      turn: 1,
    });
    await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    await expectFlushError(ctx.sessions.flush(session), /id collision/);
    await ctx.fiber.dispose();
  });
});

describe("surface field round-trip", () => {
  it("scanRows with surface columns reconstructs events with surface fields", () => {
    const rows: EventRow[] = [
      {
        fSequence: 0,
        fOriginalSeq: 0,
        fKind: "user/message",
        fCreatedAt: 1,
        fData: JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        fSourceEventSeqs: null,
        fSurfaceOp: '{"op":"replace","start":0,"end":0}',
      },
      {
        fSequence: 1,
        fOriginalSeq: 1,
        fKind: "turn/end",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, reason: { kind: "completed" } }),
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
    ];
    const { preserved } = scanRows(rows);
    expect(preserved).toHaveLength(2);
    expect((preserved[0]! as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 0, end: 0 });
    expect((preserved[0]! as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    expect((preserved[1] as SessionEvent<SurfaceEventType>).surfaceOp).toBeUndefined();
  });

  it("append and load round-trips surface fields through SQLite", async () => {
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
    const session = ctx.sessions.create(SessionId("roundtrip-surface"));
    session.append("turn/start", {
      turn: 1,
    });
    session.append("step/start", { turn: 1, step: 1 });
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [],
          source: {
            kind: "model",
            provider: "mock",
            model: "mock",
          },
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [2] },
    );
    session.append("step/end", { turn: 1, step: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await ctx.sessions.flush(session);
    const loaded = await ctx.sessionPersistence.load(SessionId("roundtrip-surface"));
    expect(loaded.events).toHaveLength(6);
    const um = loaded.events[2]!;
    expect((um as SurfaceEvent).surfaceOp).toBe("append");
    expect((um as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    const am = loaded.events[3]!;
    expect((am as SurfaceEvent).surfaceOp).toBe("append");
    expect((am as SurfaceEvent).sourceEventSeqs).toEqual([2]);
    await fiber.dispose();
  });
});
