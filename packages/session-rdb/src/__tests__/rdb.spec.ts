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
import { SessionStore, SessionId, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import type {
  Session,
  SessionEvent,
  SurfaceEvent,
  SurfaceEventType,
} from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite, { SCHEMA_VERSION, EPHEMERAL_EVENT_TYPES } from "../index.ts";
import { parseJsonlArtifact } from "../import.ts";
import {
  buildSeqMap,
  findSurfaceRepairs,
  recomputeReplaceProvenance,
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
      (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding,
       f_data, f_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, parentId, kind, "", "", "", "", "json", JSON.stringify(data), seq + 1);
  db.prepare(
    "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, eventId, seq, seq, null);
  return eventId;
}

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
          (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding,
           f_data, f_created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        head.f_head_event_id,
        "assistant/chunk",
        "",
        "",
        "",
        "",
        "json",
        "{not valid json",
        99,
      );
      db.prepare(
        "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op) VALUES (?, ?, ?, ?, ?)",
      ).run(id, eventId, next, next, null);
      db.close();
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describe("eventDimensions", () => {
  it("classifies boundary events as turn kind with empty role", () => {
    const { kind, role, name, actionId } = eventDimensions({
      type: "turn/start",
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
    });
    expect([kind, role, name, actionId]).toEqual(["turn", "", "", ""]);
  });

  it("classifies messages as user/assistant roles", () => {
    expect(
      eventDimensions({
        type: "user/message",
        seq: SessionSeq(1),
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
        seq: SessionSeq(2),
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
    ).toBe("assistant");
  });

  it("classifies assistant/message with reasoning blocks as thinking kind", () => {
    const dims = eventDimensions({
      type: "assistant/message",
      seq: SessionSeq(2),
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "answer" },
          ],
          source: { kind: "model", provider: "mock", model: "mock" },
        }),
      },
    });
    expect(dims.kind).toBe("thinking");
    expect(dims.role).toBe("assistant");
  });

  it("extracts the function name and call id from tool/call", () => {
    const dims = eventDimensions({
      type: "tool/call",
      seq: SessionSeq(4),
      time: 5,
      data: { turn: 1, step: 1, callId: ToolCallId("call-1"), name: "read", arguments: "{}" },
    });
    expect(dims).toEqual({ kind: "tool", role: "", name: "read", actionId: "call-1" });
  });

  it("extracts the call id from tool/result and classifies todo/write as todo kind", () => {
    const callId = ToolCallId("call-2");
    const result = eventDimensions({
      type: "tool/result",
      seq: SessionSeq(5),
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
    expect(result).toEqual({ kind: "tool", role: "tool", name: "", actionId: "call-2" });
    expect(
      eventDimensions({ type: "todo/write", seq: SessionSeq(6), time: 7, data: { todos: [] } }),
    ).toEqual({
      kind: "todo",
      role: "",
      name: "todos",
      actionId: "",
    });
  });

  it("keeps empty defaults for unknown plugin-merged event types", () => {
    expect(
      eventDimensions({
        type: "plugin/custom",
        seq: SessionSeq(0),
        time: 1,
        data: {},
      } as SessionEvent),
    ).toEqual({ kind: "", role: "", name: "", actionId: "" });
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
    ({ type: "plugin/x", seq: SessionSeq(0), time: 1, data: null, ...extra }) as SessionEvent;

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
      seq: SessionSeq(0),
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
        fEventId: `evt-${e.seq}`,
        fSequence: e.seq,
        fOriginalSeq: e.seq,
        fType: e.type,
        fKind: "",
        fRole: "",
        fName: "",
        fActionId: "",
        fCreatedAt: e.time,
        fData: JSON.stringify(e.data),
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
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 2 },
      },
      { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
    ];
    const { preserved, tornFrom } = scanRows(rows(withOpenTurn));
    expect(preserved.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tornFrom).toBeUndefined();
  });

  it("preserves the contiguous prefix and flags a torn tail at a seq gap", () => {
    const gapped: SessionEvent[] = [
      {
        type: "turn/start",
        seq: SessionSeq(0),
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
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
        seq: SessionSeq(0),
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
      {
        type: "turn/end",
        seq: SessionSeq(3),
        time: 3,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ];
    expect(() => scanRows(rows(gapped))).toThrow(/seq gap in committed region/);
  });

  it("throws on an unparsable row inside the committed region", () => {
    const withCorruptCommitted: EventRow[] = [
      {
        fEventId: "evt-0",
        fSequence: 0,
        fOriginalSeq: 0,
        fType: "turn/start",
        fKind: "",
        fRole: "",
        fName: "",
        fActionId: "",
        fCreatedAt: 1,
        fData: "{not json",
        fSurfaceOp: null,
      },
      {
        fEventId: "evt-1",
        fSequence: 1,
        fOriginalSeq: 1,
        fType: "turn/end",
        fKind: "",
        fRole: "",
        fName: "",
        fActionId: "",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, reason: { kind: "completed" } }),
        fSurfaceOp: null,
      },
    ];
    expect(() => scanRows(withCorruptCommitted)).toThrow(/unparsable committed event/);
  });

  it("tolerates an unparsable torn-tail row after the last turn/end", () => {
    const withCorruptTail: EventRow[] = [
      ...rows(oneTurnLog()),
      {
        fEventId: "evt-6",
        fSequence: 6,
        fOriginalSeq: 6,
        fType: "turn/start",
        fKind: "",
        fRole: "",
        fName: "",
        fActionId: "",
        fCreatedAt: 7,
        fData: "{not json",
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
      fEventId: "evt-0",
      fSequence: 0,
      fOriginalSeq: 0,
      fType: "assistant/message",
      fKind: "message",
      fRole: "assistant",
      fName: "",
      fActionId: "",
      fCreatedAt: 1,
      fData: JSON.stringify({ turn: 1, step: 1, content: [] }),
      fSurfaceOp: JSON.stringify("append"),
    };
    const event = rowToEvent(row, new Map<number, number>([[0, 0]]));
    expect(event.seq).toBe(0);
    expect((event as SurfaceEvent).surfaceOp).toBe("append");
    // sourceEventSeqs 不落库：append 事件不带 provenance。
    expect((event as SurfaceEvent).sourceEventSeqs).toBeUndefined();
  });

  it("remaps a positional replace surfaceOp through the upstream→persisted seq map", () => {
    // The dense persisted seq must be used for the replacement range, or the
    // surface fold rejects the log ("start seq N not found in surface").
    const row: EventRow = {
      fEventId: "evt-30",
      fSequence: 30,
      fOriginalSeq: 30,
      fType: "tool/result",
      fKind: "tool",
      fRole: "tool",
      fName: "",
      fActionId: "c",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 1,
        step: 1,
        message: { source: { kind: "tool", callId: "c" }, content: [] },
      }),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 2, end: 2 }),
    };
    const map = new Map<number, number>([
      [2, 5],
      [30, 9],
    ]);
    const event = rowToEvent(row, map);
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 5, end: 5 });
  });

  it("remaps a compaction/summary shadowedRange through the upstream→persisted seq map", () => {
    // The metering event's shadow-price claim names the replaced range by
    // UPSTREAM seq; it must follow the replace's surfaceOp into dense space or
    // the token-meter fold rejects the log ("token surface: replace ... has no
    // adjacent shadow price").
    const row: EventRow = {
      fEventId: "evt-4056",
      fSequence: 4056,
      fOriginalSeq: 400_000,
      fType: "compaction/summary",
      fKind: "compaction",
      fRole: "",
      fName: "",
      fActionId: "",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 1,
        summary: "…",
        shadowedRange: { start: 15, end: 398_881 },
        shadowedTokenCount: 12_345,
      }),
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
      fEventId: "evt-10",
      fSequence: 10,
      fOriginalSeq: 10,
      fType: "compaction/prune",
      fKind: "compaction",
      fRole: "",
      fName: "",
      fActionId: "",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 2,
        shadowedRange: { start: 7, end: 9 },
        shadowedTokenCount: 42,
      }),
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

  it("keeps a compact shadowedRange verbatim with an identity map (no delta filtering)", () => {
    const row: EventRow = {
      fEventId: "evt-3",
      fSequence: 3,
      fOriginalSeq: 3,
      fType: "compaction/summary",
      fKind: "compaction",
      fRole: "",
      fName: "",
      fActionId: "",
      fCreatedAt: 1,
      fData: JSON.stringify({
        turn: 1,
        shadowedRange: { start: 1, end: 2 },
        shadowedTokenCount: 9,
      }),
      fSurfaceOp: null,
    };
    expect(rowToEvent(row, new Map<number, number>([[3, 3]])).data).toMatchObject({
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
        fEventId: "evt-4056",
        fSequence: 4056,
        fOriginalSeq: 4056,
        fType: "compaction/summary",
        fKind: "compaction",
        fRole: "",
        fName: "",
        fActionId: "",
        fCreatedAt: 1,
        fData: JSON.stringify({
          turn: 1,
          shadowedRange: { start: 15, end: 398_881 },
          shadowedTokenCount: 12_345,
        }),
        fSurfaceOp: null,
      },
      map,
    );
    const replacement = rowToEvent(
      {
        fEventId: "evt-4057",
        fSequence: 4057,
        fOriginalSeq: 4057,
        fType: "assistant/message",
        fKind: "message",
        fRole: "assistant",
        fName: "",
        fActionId: "",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, step: 1, message: { role: "assistant", content: [] } }),
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

describe("findSurfaceRepairs", () => {
  function toolResult(
    seq: number,
    text: string,
    extra: Partial<SessionEvent> = {},
    messageId?: string,
  ): SessionEvent {
    const message = createMessage({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: ToolCallId("call-1"),
          content: [{ type: "text", text }],
          isError: false,
        },
      ],
      source: { kind: "tool", callId: ToolCallId("call-1") },
    });
    return {
      type: "tool/result",
      seq: SessionSeq(seq),
      time: seq,
      data: {
        turn: 1,
        step: 1,
        // 真实重写继承原 message 的 id（上游 replacementStart 语义）。
        message: messageId === undefined ? message : { ...message, id: messageId },
      },
      ...extra,
    } as SessionEvent;
  }

  it("degrades an invalid tool/result replace to append (the reported load failure)", () => {
    // 用户报告的损坏样式：seq 4556 的 tool/result replace 指向的当前 surface
    // 节点不是 tool/result（上游 assertToolResultRewrite 校验失败）。
    const events: SessionEvent[] = [
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/message",
        seq: SessionSeq(3),
        time: 4,
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
      } as SessionEvent,
      { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(5),
        time: 6,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      // 非法 tool/result replace：range [1,3] 的当前 surface 节点是
      // user/message @1 + assistant/message @3，不是 tool/result。
      toolResult(6, "pruned", {
        surfaceOp: { op: "replace", start: SessionSeq(1), end: SessionSeq(3) },
      }),
    ];
    const repairs = findSurfaceRepairs(events);
    expect([...repairs.degradeToAppend]).toEqual([6]);
    expect(repairs.addAppendMarker.size).toBe(0);
    expect(repairs.clearSurfaceOp.size).toBe(0);
  });

  it("keeps a valid tool/result content-only rewrite untouched", () => {
    const original = toolResult(5, "full result", { surfaceOp: "append" }, "msg-1");
    const replacement = toolResult(
      6,
      "pruned",
      { surfaceOp: { op: "replace", start: SessionSeq(5), end: SessionSeq(5) } },
      "msg-1",
    );
    const events: SessionEvent[] = [
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/message",
        seq: SessionSeq(3),
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [
              { type: "tool-call", id: ToolCallId("call-1"), name: "read", arguments: "{}" },
            ],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
      } as SessionEvent,
      { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
      original,
      replacement,
    ];
    const repairs = findSurfaceRepairs(events);
    expect(repairs.degradeToAppend.size).toBe(0);
    expect(repairs.addAppendMarker.size).toBe(0);
    expect(repairs.clearSurfaceOp.size).toBe(0);
  });

  it("degrades a replace whose range is not in the current surface", () => {
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(0),
        time: 1,
        data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(1),
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        // range 起点 9 不在当前 surface（只有 0、1）。
        surfaceOp: { op: "replace", start: 9, end: 1 },
      } as SessionEvent,
    ];
    const repairs = findSurfaceRepairs(events);
    expect([...repairs.degradeToAppend]).toEqual([1]);
  });

  it("marks surface-eligible events missing surfaceOp and clears it on non-eligible events", () => {
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(0),
        time: 1,
        data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
        // 缺 surfaceOp（surface-eligible 事件必须携带）。
      } as SessionEvent,
      {
        type: "turn/end",
        seq: SessionSeq(1),
        time: 2,
        data: { turn: 1, reason: { kind: "completed" } },
        // 非 surface-eligible 事件携带 surfaceOp。
        surfaceOp: "append",
      } as SessionEvent,
    ];
    const repairs = findSurfaceRepairs(events);
    expect([...repairs.addAppendMarker]).toEqual([0]);
    expect([...repairs.clearSurfaceOp]).toEqual([1]);
    expect(repairs.degradeToAppend.size).toBe(0);
  });

  it("degrades a malformed surfaceOp shape", () => {
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(0),
        time: 1,
        data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(1),
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        // 畸形 replace：start 是字符串。
        surfaceOp: { op: "replace", start: "1", end: 0 },
      } as unknown as SessionEvent,
    ];
    const repairs = findSurfaceRepairs(events);
    expect([...repairs.degradeToAppend]).toEqual([1]);
  });
});

describe("recomputeReplaceProvenance", () => {
  it("recomputes sourceEventSeqs as the range's surface nodes for every replace", () => {
    const events: SessionEvent[] = [
      { type: "turn/start", seq: SessionSeq(7), time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(8),
        time: 2,
        data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      {
        type: "turn/end",
        seq: SessionSeq(9),
        time: 3,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      {
        type: "user/message",
        seq: SessionSeq(40),
        time: 4,
        data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "user" } },
        surfaceOp: { op: "replace", start: 7, end: 9 },
      } as SessionEvent,
    ];
    recomputeReplaceProvenance(events);
    const checkpoint = events[3] as SessionEvent & { sourceEventSeqs?: number[] };
    // 只有 surface 节点（user/message @ 8）进 provenance；turn/start/end 不是。
    expect(checkpoint.sourceEventSeqs).toEqual([8]);
    // Non-replace events are untouched.
    expect(events[1]).toMatchObject({ seq: SessionSeq(8), surfaceOp: "append" });
    expect(
      (events[1] as SessionEvent & { sourceEventSeqs?: number[] }).sourceEventSeqs,
    ).toBeUndefined();
  });

  it("merges every surface node in the range (assistant/message included)", () => {
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(10),
        time: 1,
        data: { content: [{ type: "text", text: "old" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(11),
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
      {
        type: "turn/end",
        seq: SessionSeq(12),
        time: 3,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      {
        type: "user/message",
        seq: SessionSeq(20),
        time: 4,
        data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "user" } },
        surfaceOp: { op: "replace", start: 10, end: 12 },
      } as SessionEvent,
    ];
    recomputeReplaceProvenance(events);
    const checkpoint = events[3] as SessionEvent & { sourceEventSeqs?: number[] };
    // user/message @ 10 + assistant/message @ 11 are surface nodes in the range.
    expect(checkpoint.sourceEventSeqs).toEqual([10, 11]);
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
    expect(
      remapSurfaceOp(
        { op: "replace", start: SessionSeq(2), end: SessionSeq(4) },
        (seq) => seq * 10,
      ),
    ).toEqual({
      op: "replace",
      start: SessionSeq(20),
      end: SessionSeq(40),
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
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 2 },
      },
      { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
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
        seq: SessionSeq(10),
        time: 9,
        data: { turn: 3 },
      },
      {
        type: "turn/end",
        seq: SessionSeq(11),
        time: 10,
        data: { turn: 3, reason: { kind: "completed" } },
      },
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
      SELECT se.f_sequence, e.f_type FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as { f_sequence: number; f_type: string }[];
    probe.close();
    expect(stored.map((r) => r.f_sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(stored.at(-1)!.f_type).toBe("turn/end");
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
        (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding,
         f_data, f_created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      head.f_head_event_id,
      "turn/start",
      "turn",
      "",
      "",
      "",
      "json",
      "{not valid json",
      7,
    );
    db.prepare(
      "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op) VALUES (?, ?, ?, ?, ?)",
    ).run(m.id, eventId, 6, 6, null);
    db.close();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(loaded.events).toEqual(oneTurnLog()); // torn tail discarded, committed intact (turn 1 already balanced → no closers)
    // load physically deleted the corrupt tail row, so a fresh append continues.
    await b2.ctx.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: SessionSeq(6),
        time: 8,
        data: { turn: 2 },
      },
      {
        type: "turn/end",
        seq: SessionSeq(7),
        time: 9,
        data: { turn: 2, reason: { kind: "completed" } },
      },
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
    await (b.ctx.sessionPersistence as SessionPersistenceSqlite).commitRepair(
      { meta: m, inheritedEventCount: SessionLogOffset(0) },
      undefined,
      [],
    );
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

function chunkedTurnLog(): SessionEvent[] {
  return [
    {
      type: "turn/start",
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
    },
    {
      type: "user/message",
      seq: SessionSeq(1),
      time: 2,
      data: createUserMessage({
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
    {
      type: "assistant/chunk",
      seq: SessionSeq(3),
      time: 4,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
    },
    {
      type: "assistant/chunk",
      seq: SessionSeq(4),
      time: 5,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
    },
    {
      type: "assistant/message",
      seq: SessionSeq(5),
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
      sourceEventSeqs: [1].map((n) => SessionSeq(n)),
    },
    { type: "step/end", seq: SessionSeq(6), time: 7, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: SessionSeq(7),
      time: 8,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

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
      SELECT se.f_sequence, se.f_original_seq, e.f_type, e.f_role FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as {
      f_sequence: number;
      f_original_seq: number;
      f_type: string;
      f_role: string;
    }[];
    expect(rows).toEqual([
      { f_sequence: 0, f_original_seq: SessionSeq(0), f_type: "turn/start", f_role: "" },
      { f_sequence: 1, f_original_seq: SessionSeq(1), f_type: "user/message", f_role: "user" },
      { f_sequence: 2, f_original_seq: SessionSeq(2), f_type: "step/start", f_role: "" },
      {
        f_sequence: 3,
        f_original_seq: SessionSeq(5),
        f_type: "assistant/message",
        f_role: "assistant",
      },
      { f_sequence: 4, f_original_seq: SessionSeq(6), f_type: "step/end", f_role: "" },
      { f_sequence: 5, f_original_seq: SessionSeq(7), f_type: "turn/end", f_role: "" },
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
        seq: SessionSeq(0),
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
      oneTurnLog().map((e) => ({ ...e, seq: SessionSeq(e.seq + 1) })),
    );
    expect(await b.ctx.sessionPersistence.list()).toHaveLength(1);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b.dispose();
  });

  it("drops assistant/message sourceEventSeqs (chunk refs never persisted)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-prune-same");
    await b.ctx.sessionPersistence.create(m);
    // The assistant/message references the chunk events (upstream seqs 3,4),
    // which are dropped at write time — sourceEventSeqs 不落库（读取时对
    // replace 事件重计算；append 事件不带 provenance）。
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: SessionSeq(0),
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: SessionSeq(2),
        time: 3,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: SessionSeq(4),
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
        sourceEventSeqs: [2, 3].map((n) => SessionSeq(n)),
      },
      { type: "step/end", seq: SessionSeq(5), time: 6, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ]);
    // Reload replays cleanly: the dense assistant/message carries no provenance.
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(2); // dense
    expect((assistant as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    await b.dispose();
  });

  it("drops assistant/message sourceEventSeqs across batches (chunk refs never persisted)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-prune-cross");
    await b.ctx.sessionPersistence.create(m);
    // Batch 1: only deltas (dropped, no materialization).
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "assistant/chunk",
        seq: SessionSeq(0),
        time: 1,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(1),
        time: 2,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
    ]);
    // Batch 2: the message referencing batch 1's dropped seqs.
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "assistant/message",
        seq: SessionSeq(2),
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
        sourceEventSeqs: [0, 1].map((n) => SessionSeq(n)),
      },
      {
        type: "turn/end",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ]);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(0); // dense
    expect((assistant as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    await b.dispose();
  });

  it("drops assistant/message sourceEventSeqs even when referencing persisted events (append semantics)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-prune-mixed");
    await b.ctx.sessionPersistence.create(m);
    // The user/message (upstream seq 1) survives, the chunks (seqs 3,4) do not;
    // the message references all three — sourceEventSeqs 不落库，append 事件
    // 读取时也不带 provenance（只有 replace 事件重计算）。
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "turn/start",
        seq: SessionSeq(0),
        time: 1,
        data: { turn: 1 },
      },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(4),
        time: 5,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: SessionSeq(5),
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
        sourceEventSeqs: [1, 3, 4].map((n) => SessionSeq(n)),
      },
      { type: "step/end", seq: SessionSeq(6), time: 7, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(7),
        time: 8,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ]);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect((assistant as SurfaceEvent).sourceEventSeqs).toBeUndefined();
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

  it("loads without provenance on append events (chunk refs never persisted)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-provenance");
    await b.ctx.sessionPersistence.create(m);
    // user/message seq 0; the assistant/message after the delta stream carries
    // sourceEventSeqs [1] (the user message's UPSTREAM seq 1) — 不落库。
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());

    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(3); // dense
    expect((assistant as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    await b.dispose();
  });

  it("readFrom returns the dense suffix with provenance remapped", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-readfrom");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());
    const suffix = await b.ctx.sessionPersistence.readFrom(m.id, SessionLogOffset(3));
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
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 2 },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(7),
        time: 8,
        data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "gone" } },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(8),
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
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      // Unknown plugin event marked ignorable: dropped, never persisted.
      {
        type: "plugin/test",
        seq: SessionSeq(1),
        time: 2,
        data: null,
        ignorable: true,
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(2),
        time: 3,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      {
        type: "turn/end",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ]);
    // The ignorable event is absent from storage; survivors are dense.
    const probe = openDatabase(path, "wal");
    const rows = probe
      .prepare(`
      SELECT se.f_sequence, se.f_original_seq, e.f_type FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as { f_sequence: number; f_original_seq: number; f_type: string }[];
    expect(rows).toEqual([
      { f_sequence: 0, f_original_seq: SessionSeq(0), f_type: "turn/start" },
      { f_sequence: 1, f_original_seq: SessionSeq(2), f_type: "user/message" },
      { f_sequence: 2, f_original_seq: SessionSeq(3), f_type: "turn/end" },
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
        seq: SessionSeq(0),
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
      oneTurnLog().map((e) => ({ ...e, seq: SessionSeq(e.seq + 1) })),
    );
    expect(await b.ctx.sessionPersistence.list()).toHaveLength(1);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b.dispose();
  });

  it("drops assistant/message sourceEventSeqs referencing ignorable events (append semantics)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("ignorable-prune");
    await b.ctx.sessionPersistence.create(m);
    // The assistant/message references the ignorable plugin event (upstream
    // seq 1), which is dropped at write time — sourceEventSeqs 不落库。
    await b.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: "plugin/test",
        seq: SessionSeq(1),
        time: 2,
        data: null,
        ignorable: true,
      } as unknown as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(2),
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
        sourceEventSeqs: [1].map((n) => SessionSeq(n)),
      },
      {
        type: "turn/end",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ]);
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
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(4),
        time: 5,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: SessionSeq(5),
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
        sourceEventSeqs: [3, 4].map((n) => SessionSeq(n)),
      },
      { type: "step/end", seq: SessionSeq(6), time: 7, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(7),
        time: 8,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      { type: "turn/start", seq: SessionSeq(8), time: 9, data: { turn: 2 } },
      { type: "step/start", seq: SessionSeq(9), time: 10, data: { turn: 2, step: 1 } },
      { type: "compaction/start", seq: SessionSeq(10), time: 11, data: { turn: 2 } },
      {
        type: "compaction/summary",
        seq: SessionSeq(11),
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
        seq: SessionSeq(12),
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
        sourceEventSeqs: [1, 5].map((n) => SessionSeq(n)),
      },
      { type: "step/end", seq: SessionSeq(13), time: 14, data: { turn: 2, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(14),
        time: 15,
        data: { turn: 2, reason: { kind: "completed" } },
      },
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

  it("readRaw exports upstream-coordinate provenance remapped into dense space", async () => {
    // append 时事件 seq 是上游坐标,replace 的 sourceEventSeqs 引用上游 seq
    // (delta 被过滤后稠密重编号)——存储即「旧数据」样式。导出（readRaw）在
    // 序列化前重算 provenance 并重映射坐标,产出的 artifact 无需任何修复即可
    // 导入加载。
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("export-provenance");
    await b.ctx.sessionPersistence.create(m);
    const log = [
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(4),
        time: 5,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: SessionSeq(5),
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
      { type: "step/end", seq: SessionSeq(6), time: 7, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(7),
        time: 8,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      { type: "turn/start", seq: SessionSeq(8), time: 9, data: { turn: 2 } },
      { type: "step/start", seq: SessionSeq(9), time: 10, data: { turn: 2, step: 1 } },
      {
        type: "assistant/message",
        seq: SessionSeq(10),
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
        sourceEventSeqs: [1, 5].map((n) => SessionSeq(n)),
      },
      { type: "step/end", seq: SessionSeq(11), time: 12, data: { turn: 2, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(12),
        time: 13,
        data: { turn: 2, reason: { kind: "completed" } },
      },
    ] as unknown as SessionEvent[];
    await b.ctx.sessionPersistence.append(m.id, log);

    const persistence = b.ctx.sessionPersistence as SessionPersistenceSqlite;
    const backendApi = persistence.internals().backend;
    // 存储是上游坐标:replace [1,5] 原样落桥接行 f_surface_op。
    const rowBefore = (await backendApi.getEventRows(m.id)).find((r) => r.fSequence === 8)!;
    expect(rowBefore.fSurfaceOp).toBe(JSON.stringify({ op: "replace", start: 1, end: 5 }));

    // 导出即修复：artifact 中 replace 已是稠密坐标,provenance 已重算。
    const raw = await persistence.readRaw(m.id);
    expect(raw).toBeDefined();
    const parsed = parseJsonlArtifact(raw!.content);
    const replacement = parsed.events.find((e) => e.type === "assistant/message" && e.seq === 8)!;
    expect((replacement as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 1, end: 3 });
    expect((replacement as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);

    // 导入 artifact 后无需任何修复即可完整加载。
    const importedId = `session-imported` as SessionId;
    await persistence.create(
      { ...parsed.meta, id: importedId },
      parsed.inheritedEventCount as unknown as number,
    );
    await persistence.append(importedId, parsed.events);
    const reloaded = await b.ctx.sessionPersistence.load(importedId);
    const replacementAfter = reloaded.events.find(
      (e) => e.type === "assistant/message" && e.seq === 8,
    )!;
    expect((replacementAfter as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);
    await b.dispose();
  });

  it("readRaw repairs invalid tool/result surface replacements so the artifact loads", async () => {
    // 用户报告的损坏样式：tool/result replace 指向的当前 surface 节点不是
    // tool/result（上游 assertToolResultRewrite 校验失败）——load 抛
    // "invalid seed event ... must target a current tool/result"。导出
    // （readRaw）把该 replace 降级为 append,产出的 artifact 导入后即可加载。
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("export-tool-result");
    await b.ctx.sessionPersistence.create(m);
    const callId = ToolCallId("call-1");
    const log = [
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/message",
        seq: SessionSeq(3),
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "tool-call", id: callId, name: "read", arguments: "{}" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
        surfaceOp: "append",
      },
      { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
      {
        type: "tool/result",
        seq: SessionSeq(5),
        time: 6,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: callId,
                content: [{ type: "text", text: "pruned" }],
                isError: false,
              },
            ],
            source: { kind: "tool", callId },
          }),
        },
        // 非法 replace：range [1,1] 的当前 surface 节点是 user/message @1，
        // 不是 tool/result（上游 assertToolResultRewrite 校验失败）。
        surfaceOp: { op: "replace", start: 1, end: 1 },
      },
      {
        type: "turn/end",
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ] as unknown as SessionEvent[];
    await b.ctx.sessionPersistence.append(m.id, log);

    // 源会话：seed 校验失败（历史加载失败）。
    await expect(b.ctx.sessionPersistence.load(m.id)).rejects.toThrow(
      /invalid seed event at index 5: tool\/result surface replacement must target a current tool\/result/,
    );

    // 导出即修复：非法 replace 降级为 append,artifact 完备可用。
    const persistence = b.ctx.sessionPersistence as SessionPersistenceSqlite;
    const raw = await persistence.readRaw(m.id);
    expect(raw).toBeDefined();
    const parsed = parseJsonlArtifact(raw!.content);
    const result = parsed.events.find((e) => e.type === "tool/result")!;
    expect((result as SurfaceEvent).surfaceOp).toBe("append");

    // 导入 artifact 后无需任何修复即可完整加载。
    const importedId = `session-imported` as SessionId;
    await persistence.create(
      { ...parsed.meta, id: importedId },
      parsed.inheritedEventCount as unknown as number,
    );
    await persistence.append(importedId, parsed.events);
    const loaded = await b.ctx.sessionPersistence.load(importedId);
    const importedResult = loaded.events.find((e) => e.type === "tool/result")!;
    expect((importedResult as SurfaceEvent).surfaceOp).toBe("append");
    expect(loaded.events.at(-1)?.type).toBe("turn/end");
    await b.dispose();
  });

  it("readRaw repairs without mutating storage (export-time repair is view-only)", async () => {
    // 导出即修复只作用于导出视图,不落库——写路径零转换不变量不变：导出前后
    // 存储行（f_surface_op / f_original_seq）与 revision 完全一致。
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("export-view-only");
    await b.ctx.sessionPersistence.create(m);
    // 带 assistant/chunk 的 log：chunk 落盘被过滤，后续事件稠密重编号
    // （f_original_seq ≠ f_sequence）——导出会重映射坐标，但不写回存储。
    const log = [
      { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      {
        type: "assistant/chunk",
        seq: SessionSeq(3),
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      },
      {
        type: "assistant/chunk",
        seq: SessionSeq(4),
        time: 5,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
      },
      {
        type: "assistant/message",
        seq: SessionSeq(5),
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
      { type: "step/end", seq: SessionSeq(6), time: 7, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(7),
        time: 8,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ] as unknown as SessionEvent[];
    await b.ctx.sessionPersistence.append(m.id, log);

    const persistence = b.ctx.sessionPersistence as SessionPersistenceSqlite;
    const backendApi = persistence.internals().backend;
    const rowsBefore = await backendApi.getEventRows(m.id);
    const revisionBefore = await persistence.readStoredRevision(m.id);

    // 导出（含修复）不落库。
    const raw = await persistence.readRaw(m.id);
    expect(raw).toBeDefined();
    const rowsAfter = await backendApi.getEventRows(m.id);
    expect(rowsAfter).toEqual(rowsBefore);
    expect(await persistence.readStoredRevision(m.id)).toBe(revisionBefore);

    // 存储视图不变：读取仍经 f_original_seq 映射重映射。
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.at(-1)?.type).toBe("turn/end");
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
        fEventId: "evt-0",
        fSequence: 0,
        fOriginalSeq: 0,
        fType: "user/message",
        fKind: "message",
        fRole: "user",
        fName: "",
        fActionId: "",
        fCreatedAt: 1,
        fData: JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        fSurfaceOp: '{"op":"replace","start":0,"end":0}',
      },
      {
        fEventId: "evt-1",
        fSequence: 1,
        fOriginalSeq: 1,
        fType: "turn/end",
        fKind: "turn",
        fRole: "",
        fName: "",
        fActionId: "",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, reason: { kind: "completed" } }),
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
      { surfaceOp: "append", sourceEventSeqs: [2].map((n) => SessionSeq(n)) },
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
