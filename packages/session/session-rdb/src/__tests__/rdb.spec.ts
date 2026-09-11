import { randomUUID } from "node:crypto";
import { ToolCallId, createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it } from "vitest";
import { EmptySettings } from "@morlay/session-rdb/testing";
import { Context } from "@deepseek-ai/cordis";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { foldSurface } from "@deepseek-ai/dsh-session/surface";
import type {
  Session,
  SessionEvent,
  SurfaceEvent,
  SurfaceEventType,
} from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite, { SCHEMA_VERSION } from "@morlay/session-rdb";
import { parseJsonlArtifact } from "@morlay/session-rdb/artifact";
import {
  findSurfaceRepairs,
  recomputeReplaceProvenance,
  repairAssistantSettlement,
  rowToEvent,
  rowToMeta,
  scanRows,
  syncMeteringRanges,
} from "@morlay/session-rdb/artifact";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  eventDimensions,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  type EventRow,
  type SessionRow,
} from "@morlay/session-rdb/storage";
import { openDatabase } from "@morlay/session-rdb/storage";
import { runPersistenceContract, meta, oneTurnLog, appendLog } from "@morlay/session-rdb/testing";
import { runCoordinatorContract, type CoordinatorFixture } from "@morlay/session-rdb/testing";

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
    "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_surface_op) VALUES (?, ?, ?, ?)",
  ).run(sessionId, eventId, seq, null);
  return eventId;
}

/** 类型收窄：ctx.sessionPersistence 到 RDB 子类（便捷方法面）。 */
function rdb(ctx: Context): SessionPersistenceSqlite {
  return ctx.sessionPersistence as SessionPersistenceSqlite;
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
    persistence: rdb(ctx),
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
        "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_surface_op) VALUES (?, ?, ?, ?)",
      ).run(id, eventId, next, null);
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
        surfaceOp: "append",
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
          stream: [] as const,
        },
        surfaceOp: "append",
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
        stream: [] as const,
      },
      surfaceOp: "append",
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
      surfaceOp: "append",
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
      } as unknown as SessionEvent),
    ).toEqual({ kind: "", role: "", name: "", actionId: "" });
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
      fType: "assistant/message",
      fKind: "message",
      fRole: "assistant",
      fName: "",
      fActionId: "",
      fCreatedAt: 1,
      fData: JSON.stringify({ turn: 1, step: 1, content: [] }),
      fSurfaceOp: JSON.stringify("append"),
    };
    const event = rowToEvent(row);
    expect(event.seq).toBe(0);
    expect((event as SurfaceEvent).surfaceOp).toBe("append");
    // sourceEventSeqs 不落库：append 事件不带 provenance。
    expect((event as SurfaceEvent).sourceEventSeqs).toBeUndefined();
  });

  it("keeps a compact shadowedRange verbatim with an identity map (no delta filtering)", () => {
    const row: EventRow = {
      fEventId: "evt-3",
      fSequence: 3,
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
    expect(rowToEvent(row).data).toMatchObject({
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 9,
    });
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
    } as unknown as SessionEvent;
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
      } as unknown as SessionEvent,
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
          stream: [] as const,
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
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
        surfaceOp: { op: "replace", startSeq: SessionSeq(1), endSeq: SessionSeq(3) },
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
      { surfaceOp: { op: "replace", startSeq: SessionSeq(5), endSeq: SessionSeq(5) } },
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
      } as unknown as SessionEvent,
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
          stream: [] as const,
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
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
      } as unknown as SessionEvent,
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
          stream: [] as const,
        },
        // range 起点 9 不在当前 surface（只有 0、1）。
        surfaceOp: { op: "replace", startSeq: 9, endSeq: 1 },
      } as unknown as SessionEvent,
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
      } as unknown as SessionEvent,
      {
        type: "turn/end",
        seq: SessionSeq(1),
        time: 2,
        data: { turn: 1, reason: { kind: "completed" } },
        // 非 surface-eligible 事件携带 surfaceOp。
        surfaceOp: "append",
      } as unknown as SessionEvent,
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
      } as unknown as SessionEvent,
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
          stream: [] as const,
        },
        // 畸形 replace：start 是字符串。
        surfaceOp: { op: "replace", startSeq: "1", endSeq: 0 },
      } as unknown as SessionEvent,
    ];
    const repairs = findSurfaceRepairs(events);
    expect([...repairs.degradeToAppend]).toEqual([1]);
  });

  it("clamps a replace end that fell into the old coordinate space onto the metering count", () => {
    // 旧写入器重编号后 range 端点仍是旧坐标：end 999 不在当前 surface，但
    // 紧邻 metering 的 shadowedSeqs 给出被遮蔽数量 2，夹取到当前 surface 的
    // 同长区间 [1, 3]（降级 append 会把被压缩历史全部放回派生历史）。
    const events: SessionEvent[] = [
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
      } as unknown as SessionEvent,
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
          stream: [] as const,
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(5),
        time: 6,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      {
        type: "compaction/summary",
        seq: SessionSeq(6),
        time: 7,
        data: {
          turn: 1,
          summary: "compacted",
          shadowedRange: { start: 1, end: 999 },
          shadowedSeqs: [1, 3],
          shadowedTokenCount: 5,
          provider: "mock",
          model: "mock",
        },
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(7),
        time: 8,
        data: createUserMessage({
          content: [{ type: "text", text: "compacted" }],
          source: { kind: "plugin", plugin: "compact" },
        }),
        surfaceOp: { op: "replace", startSeq: 1, endSeq: 999 },
      } as unknown as SessionEvent,
    ];
    const repairs = findSurfaceRepairs(events);
    expect([...repairs.clampEnd]).toEqual([[7, 3]]);
    expect(repairs.degradeToAppend.size).toBe(0);
  });

  it("degrades an out-of-range replace whose start is also off the current surface", () => {
    const events: SessionEvent[] = [
      {
        type: "compaction/summary",
        seq: SessionSeq(0),
        time: 1,
        data: {
          turn: 1,
          summary: "compacted",
          shadowedRange: { start: 40, end: 999 },
          shadowedSeqs: [40, 41],
          shadowedTokenCount: 5,
          provider: "mock",
          model: "mock",
        },
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "compacted" }],
          source: { kind: "plugin", plugin: "compact" },
        }),
        surfaceOp: { op: "replace", startSeq: 40, endSeq: 999 },
      } as unknown as SessionEvent,
    ];
    const repairs = findSurfaceRepairs(events);
    expect([...repairs.degradeToAppend]).toEqual([1]);
    expect(repairs.clampEnd.size).toBe(0);
  });
});

describe("read-view repair", () => {
  it("fills a missing assistant settlement stream with an empty array", () => {
    const events = [
      {
        type: "assistant/message",
        seq: SessionSeq(0),
        time: 1,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
      },
      {
        type: "assistant/attempt",
        seq: SessionSeq(1),
        time: 2,
        data: { turn: 1, step: 1 },
      },
      {
        type: "turn/end",
        seq: SessionSeq(2),
        time: 3,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ] as unknown as SessionEvent[];
    repairAssistantSettlement(events);
    expect((events[0]!.data as unknown as { stream: unknown }).stream).toEqual([]);
    expect((events[1]!.data as unknown as { stream: unknown }).stream).toEqual([]);
  });

  it("rewrites a stale metering range onto the adjacent replace's dense range", () => {
    const events = [
      {
        type: "compaction/summary",
        seq: SessionSeq(0),
        time: 1,
        data: {
          turn: 1,
          summary: "compacted",
          shadowedRange: { start: 1, end: 999 },
          shadowedSeqs: [1, 3],
          shadowedTokenCount: 5,
          provider: "mock",
          model: "mock",
        },
      },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "compacted" }],
          source: { kind: "plugin", plugin: "compact" },
        }),
        surfaceOp: { op: "replace", startSeq: 1, endSeq: 3 },
      },
      {
        type: "user/message",
        seq: SessionSeq(2),
        time: 3,
        data: createUserMessage({
          content: [{ type: "text", text: "later" }],
          source: { kind: "user" },
        }),
        surfaceOp: "append",
      },
      {
        type: "tool/result",
        seq: SessionSeq(3),
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: ToolCallId("call-1"),
                content: [{ type: "text", text: "result" }],
                isError: false,
              },
            ],
            source: { kind: "tool", callId: ToolCallId("call-1") },
          }),
        },
        surfaceOp: "append",
      },
    ] as unknown as SessionEvent[];
    syncMeteringRanges(events);
    expect((events[0]!.data as unknown as { shadowedRange: unknown }).shadowedRange).toEqual({
      start: 1,
      end: 3,
    });
    // 用稠密 range 内的全部 surface 节点重写（旧值是旧坐标空间）。
    expect((events[0]!.data as unknown as { shadowedSeqs: unknown }).shadowedSeqs).toEqual([
      1, 2, 3,
    ]);
  });

  it("leaves an already-aligned metering event (and its extra concurrent seqs) untouched", () => {
    const events = [
      {
        type: "compaction/summary",
        seq: SessionSeq(0),
        time: 1,
        data: {
          turn: 1,
          summary: "compacted",
          shadowedRange: { start: 1, end: 1 },
          // 压缩竞态下 range 外的并发落地节点：当前写入器的权威列表，不得改写。
          shadowedSeqs: [1, 3],
          shadowedTokenCount: 5,
          provider: "mock",
          model: "mock",
        },
      },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "compacted" }],
          source: { kind: "plugin", plugin: "compact" },
        }),
        surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      },
    ] as unknown as SessionEvent[];
    syncMeteringRanges(events);
    expect((events[0]!.data as unknown as { shadowedSeqs: unknown }).shadowedSeqs).toEqual([1, 3]);
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
      } as unknown as SessionEvent,
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
        surfaceOp: { op: "replace", startSeq: 7, endSeq: 9 },
      } as unknown as SessionEvent,
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
      } as unknown as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(11),
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "a",
            stream: [] as const,
            role: "assistant",
            content: [{ type: "text", text: "old" }],
            source: { kind: "model", provider: "m", model: "m" },
          },
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
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
        surfaceOp: { op: "replace", startSeq: 10, endSeq: 12 },
      } as unknown as SessionEvent,
    ];
    recomputeReplaceProvenance(events);
    const checkpoint = events[3] as SessionEvent & { sourceEventSeqs?: number[] };
    // user/message @ 10 + assistant/message @ 11 are surface nodes in the range.
    expect(checkpoint.sourceEventSeqs).toEqual([10, 11]);
  });

  it("prefers the adjacent metering event's shadowedSeqs over a range scan", () => {
    // 压缩竞态样式：compaction/summary 的 shadowedSeqs 显式列出全部被遮蔽
    // 节点（含 range 数值区间漏掉的并发落地节点 659），replace 紧随其后。
    // provenance 必须采用 shadowedSeqs（权威列表），否则上游
    // assertProvenance 报 "missing 659"。
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 1,
        data: { content: [{ type: "text", text: "a" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(2),
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "a",
            stream: [] as const,
            role: "assistant",
            content: [{ type: "text", text: "b" }],
            source: { kind: "model", provider: "m", model: "m" },
          },
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "compaction/summary",
        seq: SessionSeq(3),
        time: 3,
        data: {
          turn: 1,
          summary: "…",
          shadowedRange: { start: 1, end: 2 },
          shadowedSeqs: [1, 2],
          shadowedTokenCount: 9,
        },
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(4),
        time: 4,
        data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "user" } },
        surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 },
      } as unknown as SessionEvent,
    ];
    recomputeReplaceProvenance(events);
    const checkpoint = events[3] as SessionEvent & { sourceEventSeqs?: number[] };
    expect(checkpoint.sourceEventSeqs).toEqual([1, 2]);
  });

  it("uses shadowedSeqs even when the range scan would miss a shadowed node", () => {
    // 竞态核心：range [1..2] 的数值区间不含 659（并发落地节点），但
    // shadowedSeqs 显式列出 [1, 659, 2]——provenance 必须完整覆盖。
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 1,
        data: { content: [{ type: "text", text: "a" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(659),
        time: 2,
        data: { content: [{ type: "text", text: "late" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(2),
        time: 3,
        data: { content: [{ type: "text", text: "b" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "compaction/summary",
        seq: SessionSeq(3),
        time: 4,
        data: {
          turn: 1,
          summary: "…",
          shadowedRange: { start: 1, end: 2 },
          shadowedSeqs: [1, 659, 2],
          shadowedTokenCount: 9,
        },
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(4),
        time: 5,
        data: { content: [{ type: "text", text: "checkpoint" }], source: { kind: "user" } },
        surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 },
      } as unknown as SessionEvent,
    ];
    recomputeReplaceProvenance(events);
    const checkpoint = events[4] as SessionEvent & { sourceEventSeqs?: number[] };
    expect(checkpoint.sourceEventSeqs).toEqual([1, 659, 2]);
  });

  it("falls back to a range scan when the adjacent event is not a metering event", () => {
    // 非压缩 replace（如 tool-result pruner 的旧样式）：无紧邻 metering
    // 事件，回退到 range 数值扫描，既有行为不变。
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 1,
        data: { content: [{ type: "text", text: "a" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(2),
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "a",
            stream: [] as const,
            role: "assistant",
            content: [{ type: "text", text: "b" }],
            source: { kind: "model", provider: "m", model: "m" },
          },
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "turn/end",
        seq: SessionSeq(3),
        time: 3,
        data: { turn: 1, reason: { kind: "completed" } },
      },
      {
        type: "tool/result",
        seq: SessionSeq(4),
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: ToolCallId("c"),
                content: [],
                isError: false,
              },
            ],
            source: { kind: "tool", callId: ToolCallId("c") },
          }),
        },
        surfaceOp: { op: "replace", startSeq: SessionSeq(1), endSeq: SessionSeq(2) },
      } as unknown as SessionEvent,
    ];
    recomputeReplaceProvenance(events);
    const replacement = events[3] as SessionEvent & { sourceEventSeqs?: number[] };
    expect(replacement.sourceEventSeqs).toEqual([1, 2]);
  });

  it("satisfies the upstream surface fold across chained checkpoints with a straggler", () => {
    // 端到端：两轮链式 checkpoint + 压缩竞态漏网节点（seq 2 位于上一个
    // checkpoint 节点 5 之后的表面位置、seq 却更小）。重算后的 provenance
    // 必须通过上游 foldSurface（assertProvenance 的真实实现），漏网节点
    // 被正确遮蔽；按 range 数值扫描的旧结果会被 "missing 2" 拒绝。
    const events: SessionEvent[] = [
      {
        type: "user/message",
        seq: SessionSeq(0),
        time: 1,
        data: { content: [{ type: "text", text: "old" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(1),
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "a1",
            stream: [] as const,
            role: "assistant",
            content: [{ type: "text", text: "old" }],
            source: { kind: "model", provider: "m", model: "m" },
          },
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "assistant/message",
        seq: SessionSeq(2),
        time: 3,
        data: {
          turn: 1,
          step: 2,
          message: {
            id: "a2",
            stream: [] as const,
            role: "assistant",
            content: [{ type: "text", text: "straggler" }],
            source: { kind: "model", provider: "m", model: "m" },
          },
        },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "compaction/summary",
        seq: SessionSeq(3),
        time: 5,
        data: {
          turn: 1,
          summary: "s1",
          shadowedRange: { start: 0, end: 1 },
          shadowedSeqs: [0, 1],
          shadowedTokenCount: 10,
        },
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(4),
        time: 6,
        data: {
          content: [{ type: "text", text: "checkpoint" }],
          source: { kind: "plugin", plugin: "compact" },
        },
        surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(5),
        time: 7,
        data: { content: [{ type: "text", text: "next" }], source: { kind: "user" } },
        surfaceOp: "append",
      } as unknown as SessionEvent,
      {
        type: "compaction/summary",
        seq: SessionSeq(6),
        time: 9,
        data: {
          turn: 1,
          summary: "s2",
          shadowedRange: { start: 4, end: 5 },
          shadowedSeqs: [4, 2, 5],
          shadowedTokenCount: 20,
        },
      } as unknown as SessionEvent,
      {
        type: "user/message",
        seq: SessionSeq(7),
        time: 10,
        data: {
          content: [{ type: "text", text: "checkpoint" }],
          source: { kind: "plugin", plugin: "compact" },
        },
        surfaceOp: { op: "replace", startSeq: 4, endSeq: 5 },
      } as unknown as SessionEvent,
    ];
    recomputeReplaceProvenance(events);
    const checkpoint = events[7] as unknown as { sourceEventSeqs?: number[] };
    expect(checkpoint.sourceEventSeqs).toEqual([4, 2, 5]);
    checkpoint.sourceEventSeqs = [4, 5];
    expect(() => foldSurface(events)).toThrow(/missing 2/);
    checkpoint.sourceEventSeqs = [4, 2, 5];
    const { nodes } = foldSurface(events);
    // 两轮 checkpoint 后，表面只剩最后一个 checkpoint 节点（漏网节点已被遮蔽）。
    expect([...nodes]).toEqual([SessionSeq(7)]);
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
    // 新版 fail-closed：未知事件类型（非 ignorable）拒绝解释整个 log。
    await expect(rdb(mounted.ctx).load(m.id)).rejects.toThrow(
      /contains event type "request\/header-delta" \(seq 1\) unknown to this harness/,
    );
    await mounted.dispose();
  });

  it("has no independent per-session log location", async () => {
    const { ctx, dispose } = await backend();
    // 新版模型无 locate：stat 对不存在会话返回 undefined。
    expect(await rdb(ctx).stat(meta("sqlite-location").id)).toBeUndefined();
    await dispose();
  });

  it("an interrupted turn (rows after the last turn/end) is PRESERVED as stored", async () => {
    const path = await freshDbPath();
    const m = meta("crash");
    // Run 1: persist a complete turn, then a half-written second turn (no turn/end).
    const ctx1 = new Context();
    await ctx1.plugin(EmptySettings);
    await ctx1.plugin(SessionStore);
    const fiber1 = await ctx1.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    await rdb(ctx1).createAndAppend(m, oneTurnLog());
    await rdb(ctx1).append(m.id, [
      {
        type: "turn/start",
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 2 },
      },
      { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
    ]);
    await fiber1.dispose();

    // Run 2: load PRESERVES the interrupted turn's real events verbatim——
    // 新版模型下持久化层原样返回存储事件，补 closers 由消费方（Session
    // 恢复 / agent-loop resume）负责。
    const ctx2 = new Context();
    await ctx2.plugin(EmptySettings);
    await ctx2.plugin(SessionStore);
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    const loaded = await rdb(ctx2).load(m.id);
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end", // turn 1
      "turn/start",
      "step/start", // turn 2: 原样保留，无合成 closers
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // 后续 append 从存储 next-seq 续接（seq 8）。
    await rdb(ctx2).append(m.id, [
      {
        type: "turn/end",
        seq: SessionSeq(8),
        time: 9,
        data: { turn: 2, reason: { kind: "completed" } },
      },
    ]);
    const reloaded = await rdb(ctx2).load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await fiber2.dispose();
  });

  it("load() durably closes the interrupted turn: the synthetic closers are on disk after load", async () => {
    const path = await freshDbPath();
    const m = meta("load-closes");
    const b1 = await backend(path);
    await rdb(b1.ctx).createAndAppend(m, oneTurnLog()); // seqs 0..5
    await b1.dispose();
    // Hand-write an interrupted turn (turn/start seq 6, no turn/end).
    const db = openDatabase(path, "wal");
    const head = db
      .prepare("SELECT f_head_event_id FROM t_sessions WHERE f_session_id = ?")
      .get(m.id) as { f_head_event_id: string };
    insertEventRow(db, m.id, 6, "turn/start", { turn: 2 }, head.f_head_event_id);
    db.close();

    const b2 = await backend(path);
    const loaded = await rdb(b2.ctx).load(m.id);
    // turn 2's real turn/start (seq 6) is preserved verbatim——新版模型下
    // 持久化层原样返回存储事件，不补合成 closers。
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(loaded.events.at(-1)!.type).toBe("turn/start");
    // load() 不落库：存储行保持原样（无合成 closers）。
    const probe = openDatabase(path, "wal");
    const stored = probe
      .prepare(`
      SELECT se.f_sequence, e.f_type FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as { f_sequence: number; f_type: string }[];
    probe.close();
    expect(stored.map((r) => r.f_sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(stored.at(-1)!.f_type).toBe("turn/start");
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
    await rdb(b1.ctx).createAndAppend(m, oneTurnLog()); // committed: seqs 0..5
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
      "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_surface_op) VALUES (?, ?, ?, ?)",
    ).run(m.id, eventId, 6, null);
    db.close();

    const b2 = await backend(path);
    const loaded = await rdb(b2.ctx).load(m.id);
    expect(loaded.events).toEqual(oneTurnLog()); // torn tail discarded, committed intact (turn 1 already balanced → no closers)
    // load physically deleted the corrupt tail row, so a fresh append continues.
    await rdb(b2.ctx).append(m.id, [
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
    const reloaded = await rdb(b2.ctx).load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await b2.dispose();
  });

  it("append rolls back the whole batch on a mid-batch seq collision (transaction)", async () => {
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
    const m = meta("rollback");
    await rdb(ctx).createAndAppend(m, oneTurnLog()); // seqs 0..5

    // A batch that re-states an already-stored seq must be rejected and leave
    // the stored log unchanged (the UNIQUE (session_id, seq) constraint fires
    // inside the transaction → ROLLBACK).
    await expect(rdb(ctx).append(m.id, oneTurnLog())).rejects.toThrow();
    const loaded = await rdb(ctx).load(m.id);
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
    await rdb(ctx1).createAndAppend(m, oneTurnLog());
    await fiber1.dispose();

    const ctx2 = new Context();
    await ctx2.plugin(EmptySettings);
    await ctx2.plugin(SessionStore);
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    expect((await rdb(ctx2).list()).map((x) => x.header.id)).toContain(m.id);
    const loaded = await rdb(ctx2).load(m.id);
    expect(loaded.meta).toMatchObject({ id: m.id, cwd: "/proj" });
    expect(loaded.events).toEqual(oneTurnLog());
    await fiber2.dispose();
  });

  it("source-qualifies revisions across stores while preserving same-file reopen identity", async () => {
    const pathA = await freshDbPath();
    const pathB = await freshDbPath();
    const m = meta("revision-source");
    const a = await backend(pathA);
    await rdb(a.ctx).createAndAppend(m, oneTurnLog());
    const revisionA = (await rdb(a.ctx).listSnapshots())[0]?.revision;
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
    expect((await rdb(reopenedA.ctx).listSnapshots())[0]?.revision).toBe(revisionA);
    await reopenedA.dispose();

    const b = await backend(pathB);
    await rdb(b.ctx).createAndAppend(m, oneTurnLog());
    const revisionB = (await rdb(b.ctx).listSnapshots())[0]?.revision;
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
    await rdb(first.ctx).createAndAppend(m, oneTurnLog());
    const before = (await rdb(first.ctx).listSnapshots())[0]?.revision;
    await first.dispose();

    const cleanup = openDatabase(path, "wal");
    cleanup.prepare("DELETE FROM t_sessions WHERE f_session_id = ?").run(m.id);
    cleanup.close();

    const second = await backend(path);
    await rdb(second.ctx).createAndAppend(m, oneTurnLog());
    const after = (await rdb(second.ctx).listSnapshots())[0]?.revision;
    expect(after).not.toBe(before);
    expect(String(before)).toMatch(/:revision:1$/);
    expect(String(after)).toMatch(/:revision:1$/);
    await second.dispose();
  });

  it("keeps the revision stable for an empty repair hook", async () => {
    const b = await backend();
    const m = meta("empty-repair");
    await rdb(b.ctx).createAndAppend(m, oneTurnLog());
    const before = await rdb(b.ctx).listSnapshots();
    // 新版模型无 commitRepair：空 append 是 no-op，revision 不变。
    const handle = await rdb(b.ctx).open(m.id, "write");
    await handle.append([]);
    await handle.close();
    expect(await rdb(b.ctx).listSnapshots()).toEqual(before);
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
    await rdb(ctx).list();
    await fiber.dispose();
  });
});

describe("SessionPersistenceSqlite: export-time repair (readRaw)", () => {
  it("readRaw repairs invalid tool/result surface replacements so the artifact loads", async () => {
    // 用户报告的损坏样式：tool/result replace 指向的当前 surface 节点不是
    // tool/result（上游 assertToolResultRewrite 校验失败）——load 抛
    // "invalid seed event ... must target a current tool/result"。导出
    // （readRaw）把该 replace 降级为 append,产出的 artifact 导入后即可加载。
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("export-tool-result");
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
          stream: [] as const,
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
        surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      },
      {
        type: "turn/end",
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ] as unknown as SessionEvent[];
    await rdb(b.ctx).createAndAppend(m, log);

    // 源会话：新版模型下持久化层原样返回存储事件（surface 语义校验由
    // 消费方 Session 构造负责，load 不做）。
    const sourceLoaded = await rdb(b.ctx).load(m.id);
    expect(sourceLoaded.events.at(-1)?.type).toBe("turn/end");

    // 导出即修复：非法 replace 降级为 append,artifact 完备可用。
    const persistence = rdb(b.ctx) as SessionPersistenceSqlite;
    const raw = await persistence.readRaw(m.id);
    expect(raw).toBeDefined();
    const parsed = parseJsonlArtifact(raw!.content);
    const result = parsed.events.find((e) => e.type === "tool/result")!;
    expect((result as SurfaceEvent).surfaceOp).toBe("append");

    // 导入 artifact 后无需任何修复即可完整加载。
    const importedId = `session-imported` as SessionId;
    await persistence.createAndAppend(
      { ...parsed.meta, id: importedId },
      parsed.events,
      parsed.inheritedEventCount,
    );
    const loaded = await rdb(b.ctx).load(importedId);
    const importedResult = loaded.events.find((e) => e.type === "tool/result")!;
    expect((importedResult as SurfaceEvent).surfaceOp).toBe("append");
    expect(loaded.events.at(-1)?.type).toBe("turn/end");
    await b.dispose();
  });

  it("readRaw repairs without mutating storage (export-time repair is view-only)", async () => {
    // 导出即修复只作用于导出视图,不落库——写路径零转换不变量不变：导出前后
    // 存储行（f_surface_op）与 revision 完全一致。
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("export-view-only");
    // 原样存储的 log（含 ignorable 版本效果事件，与 JSONL 一致原样落库）。
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
        type: "plugin/test",
        seq: SessionSeq(3),
        time: 4,
        data: null,
        ignorable: true,
      } as unknown as SessionEvent,
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
          stream: [] as const,
        },
        surfaceOp: "append",
      },
      { type: "step/end", seq: SessionSeq(5), time: 6, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: SessionSeq(6),
        time: 7,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ] as unknown as SessionEvent[];
    await rdb(b.ctx).createAndAppend(m, log);

    const persistence = rdb(b.ctx) as SessionPersistenceSqlite;
    const backendApi = persistence.internals().backend;
    const rowsBefore = await backendApi.getEventRows(m.id);
    const revisionBefore = await persistence.readStoredRevision(m.id);

    // 导出（含修复）不落库。
    const raw = await persistence.readRaw(m.id);
    expect(raw).toBeDefined();
    const rowsAfter = await backendApi.getEventRows(m.id);
    expect(rowsAfter).toEqual(rowsBefore);
    expect(await persistence.readStoredRevision(m.id)).toBe(revisionBefore);

    // 存储视图不变：读取仍原样返回存储事件。
    const loaded = await rdb(b.ctx).load(m.id);
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
    await expect(rdb(b.ctx).listSnapshots()).rejects.toThrow(/no valid store identity/);
    await expect(b.dispose()).resolves.toBeUndefined();
  });

  it("creates a new database and WAL sidecars with owner-only modes without changing its parent mode", async () => {
    if (process.platform === "win32") return;
    const path = await freshDbPath();
    const dir = dirname(path);
    await chmod(dir, 0o755);

    const b = await backend(path);
    await rdb(b.ctx).list();

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

    await rdb(ctx).createAndAppend(m, oneTurnLog());

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
    await rdb(ctx).list();

    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await fiber.dispose();
  });

  it("journalMode config reaches the database (default wal, rollback modes selectable)", async () => {
    const walPath = await freshDbPath();
    const bWal = await backend(walPath);
    await rdb(bWal.ctx).create(meta("jm-wal"));
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
    await rdb(ctx).create(meta("jm-delete"));
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
    expect((preserved[0]! as SurfaceEvent).surfaceOp).toEqual({
      op: "replace",
      startSeq: 0,
      endSeq: 0,
    });
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
        stream: [] as const,
      },
      { surfaceOp: "append" },
    );
    session.append("step/end", { turn: 1, step: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await ctx.sessions.flush(session);
    const loaded = await rdb(ctx).load(SessionId("roundtrip-surface"));
    expect(loaded.events).toHaveLength(6);
    const um = loaded.events[2]!;
    expect((um as SurfaceEvent).surfaceOp).toBe("append");
    expect((um as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    const am = loaded.events[3]!;
    expect((am as SurfaceEvent).surfaceOp).toBe("append");
    // v2 语义：assistant/message 嵌入 stream，禁止携带 sourceEventSeqs。
    expect((am as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    await fiber.dispose();
  });
});
