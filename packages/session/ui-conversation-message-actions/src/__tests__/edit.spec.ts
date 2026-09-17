import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import {
  createPersisted,
  harness,
  meta,
  oneTurnLog,
  twoTurnLog,
  Session,
  SessionIdBrand,
  SessionSeq,
  TokenMeter,
  parseJsonlArtifact,
  type SessionEvent,
} from "@morlay/ui-conversation-message-actions/testing";

function rdb(ctx: import("@deepseek-ai/cordis").Context): SessionPersistenceSqlite {
  return ctx.sessionPersistence as SessionPersistenceSqlite;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("SessionEditor edit", () => {
  it("edits after an interrupted run (open turn with streamed output) without misreading the stored head", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
        {
          type: "user/message",
          seq: SessionSeq(13),
          time: 13,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/start", seq: SessionSeq(14), time: 14, data: { turn: 3, step: 1 } },
        {
          type: "assistant/message",
          seq: SessionSeq(15),
          time: 15,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [
              {
                type: "chunk",
                time: 15,
                chunk: { type: "block-start", index: 0, blockType: "text" },
              },
              { type: "text-chunks", time0: 15, index: 0, dt: [], texts: ["partial"] },
              {
                type: "chunk",
                time: 15,
                chunk: { type: "block-end", index: 0, block: { type: "text", text: "partial" } },
              },
              { type: "chunk", time: 15, chunk: { type: "finish", reason: { kind: "stop" } } },
            ],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(16), time: 16, data: { turn: 3, step: 1 } },
      ];
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [...twoTurnLog(), ...openTail],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const backend = (
        ctx.sessionPersistence as unknown as {
          internals(): {
            backend: { getHead(id: SessionIdBrand): Promise<{ fHeadSequence: number }> };
          };
        }
      ).internals().backend;
      expect(live.snapshotEvents().at(-1)?.seq).toBe(17);
      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(17);

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 9,
        blockIndex: 0,
        text: "edited",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));
      expect(result.queuedTurns).toBe(0);

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(live.snapshotEvents()[6]?.type).toBe("session-branch/version");
      expect(live.snapshotEvents().at(-1)?.type).toBe("turn/end");

      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(12);

      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      liveAppend.append("turn/start", { turn: 4 });
      await ctx.sessions.flush(live);
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(13);
    } finally {
      await dispose();
    }
  });

  it("edits an assistant block on a live session (manualTurn lands, cursor synced)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      const second = oneTurnLog().map(
        (e) =>
          ({
            ...e,
            seq: e.seq + 7,
            time: e.time + 100,
            data: { ...e.data, turn: 2 },
          }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [header, ...first, ...second],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 10,
        blockIndex: 0,
        text: "第二轮回答（已编辑）",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      expect(live.snapshotEvents()[7]?.type).toBe("session-branch/version");
      expect(live.snapshotEvents().at(-1)?.type).toBe("turn/end");

      const editedAssistant = live
        .snapshotEvents()
        .find((e) => e.type === "assistant/message" && e.data.turn === 2);
      expect(
        editedAssistant?.type === "assistant/message" &&
          (editedAssistant.data.message.content[0] as { text?: string }).text,
      ).toBe("第二轮回答（已编辑）");
    } finally {
      await dispose();
    }
  });

  it("replays queued input when editing the first turn (header resolved before rewind)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("live"), { meta: meta("live"), seed: [header, ...first] });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const followups: unknown[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("live")
            ? {
                session: live,
                followup: (message: unknown) => {
                  followups.push(message);
                },
                whenIdle: async () => {},
                inbox: { clear: () => {} },
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 2,
        blockIndex: 0,
        text: "第一轮问题（已编辑）",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));
      expect(followups).toHaveLength(1);

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0]);
      expect(live.snapshotEvents()[0]?.type).toBe("session-branch/version");
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("rejects edit of a message outside any closed turn", async () => {
    const { editor, dispose } = await harness();
    try {
      await expect(
        editor.edit({
          action: "edit",
          sessionId: SessionIdBrand("missing"),
          eventSeq: 1,
          blockIndex: 0,
          text: "edited",
          cascade: "truncate",
        }),
      ).rejects.toThrow();
    } finally {
      await dispose();
    }
  });

  it("edits a user message in an open turn (whole-turn rewind, drop and replay)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
        {
          type: "user/message",
          seq: SessionSeq(13),
          time: 13,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/start", seq: SessionSeq(14), time: 14, data: { turn: 3, step: 1 } },
        {
          type: "assistant/message",
          seq: SessionSeq(15),
          time: 15,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 13,
        blockIndex: 0,
        text: "go on (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));
      expect(result.queuedTurns).toBe(0);

      const backend = (
        ctx.sessionPersistence as unknown as {
          internals(): {
            backend: {
              getEventRows(
                id: SessionIdBrand,
              ): Promise<Array<{ fSequence: number; fType: string }>>;
            };
          };
        }
      ).internals().backend;
      const rows = await backend.getEventRows(SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(rows[11]?.fType).toBe("turn/end");
      expect(rows[12]?.fType).toBe("session-branch/version");

      expect(rows.some((r) => r.fType === "user/message" && r.fSequence === 13)).toBe(false);
      expect(rows.some((r) => r.fType === "assistant/message" && r.fSequence === 15)).toBe(false);
      expect(rows.some((r) => r.fType === "assistant/message" && r.fSequence === 3)).toBe(true);

      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 13,
            time: event.time + 300,
            data: { ...event.data, turn: 3 },
          }) as SessionEvent,
      );
      await rdb(ctx).append(SessionIdBrand("src"), continuation);
      const continued = await rdb(ctx).load(SessionIdBrand("src"));
      expect(continued.events.at(-1)?.type).toBe("turn/end");
      expect(continued.events).toHaveLength(19);
    } finally {
      await dispose();
    }
  });

  it("rejects editing an assistant message in an open turn", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
        {
          type: "user/message",
          seq: SessionSeq(13),
          time: 13,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/start", seq: SessionSeq(14), time: 14, data: { turn: 3, step: 1 } },
        {
          type: "assistant/message",
          seq: SessionSeq(15),
          time: 15,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      await expect(
        editor.edit({
          action: "edit",
          sessionId: SessionIdBrand("src"),
          eventSeq: 15,
          blockIndex: 0,
          text: "edited",
          cascade: "truncate",
        }),
      ).rejects.toThrow(/未闭合轮次的助手消息不可编辑/);
    } finally {
      await dispose();
    }
  });

  it("edits a user message in an open turn on a live session in real agent-loop order (memory log balanced)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
        { type: "step/start", seq: SessionSeq(13), time: 13, data: { turn: 3, step: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(14),
          time: 14,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        {
          type: "assistant/message",
          seq: SessionSeq(15),
          time: 15,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(16), time: 16, data: { turn: 3, step: 1 } },
      ];
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [...twoTurnLog(), ...openTail],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 14,
        blockIndex: 0,
        text: "go on (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));
      expect(result.queuedTurns).toBe(0);

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(live.snapshotEvents()[11]?.type).toBe("turn/end");
      expect(live.snapshotEvents()[12]?.type).toBe("session-branch/version");
      expect(live.snapshotEvents().some((e) => e.type === "step/start" && e.data.turn === 3)).toBe(
        false,
      );

      const meter = new TokenMeter(ctx);
      expect(() => meter.measure(live)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("exports a surface-corrupt session as a loadable artifact (export-time repair)", async () => {
    const { ctx, dispose } = await harness();
    try {
      const compacted: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(1),
          time: 2,
          data: {
            id: "export-user",
            role: "user",
            content: [{ type: "text", text: "hi" }],
            source: { kind: "user" },
          },
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
            message: {
              id: "turn1-assistant",
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
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
        { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
        {
          type: "assistant/message",
          seq: SessionSeq(8),
          time: 9,
          data: {
            turn: 2,
            step: 1,
            message: {
              id: "compacted",
              role: "assistant",
              content: [{ type: "text", text: "compacted" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: { op: "replace", startSeq: 1, endSeq: 3 },
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(9), time: 10, data: { turn: 2, step: 1 } },
        {
          type: "turn/end",
          seq: SessionSeq(10),
          time: 11,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await createPersisted(ctx, "export-me", compacted);

      const raw = await rdb(ctx).readRaw(SessionIdBrand("export-me"));
      expect(raw).toBeDefined();
      const parsed = parseJsonlArtifact(raw!.content);

      const importedId = SessionIdBrand("export-imported");
      const handle = await rdb(ctx).create(
        { ...parsed.meta, id: importedId },
        { inheritedEventCount: parsed.inheritedEventCount },
      );
      try {
        await handle.append(parsed.events);
      } finally {
        await handle.close();
      }
      const after = await rdb(ctx).load(importedId);
      expect(after.events.at(-1)?.type).toBe("turn/end");
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await dispose();
    }
  });

  it("edits a user message in an open turn in real agent-loop order (orphan step/start dropped, token-meter replay safe)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
        { type: "step/start", seq: SessionSeq(13), time: 13, data: { turn: 3, step: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(14),
          time: 14,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        {
          type: "assistant/message",
          seq: SessionSeq(15),
          time: 15,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [
              {
                type: "chunk",
                time: 15,
                chunk: { type: "block-start", index: 0, blockType: "text" },
              },
              { type: "text-chunks", time0: 15, index: 0, dt: [], texts: ["partial"] },
              {
                type: "chunk",
                time: 15,
                chunk: { type: "block-end", index: 0, block: { type: "text", text: "partial" } },
              },
              { type: "chunk", time: 15, chunk: { type: "finish", reason: { kind: "stop" } } },
            ],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(16), time: 16, data: { turn: 3, step: 1 } },
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 14,
        blockIndex: 0,
        text: "go on (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));
      expect(result.queuedTurns).toBe(0);

      const backend = (
        ctx.sessionPersistence as unknown as {
          internals(): {
            backend: {
              getEventRows(
                id: SessionIdBrand,
              ): Promise<Array<{ fSequence: number; fType: string }>>;
            };
          };
        }
      ).internals().backend;
      const rows = await backend.getEventRows(SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(rows[11]?.fType).toBe("turn/end");
      expect(rows[12]?.fType).toBe("session-branch/version");
      expect(rows.some((r) => r.fType === "step/start" && r.fSequence === 13)).toBe(false);

      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 13,
            time: event.time + 300,
            data: { ...event.data, turn: 3 },
          }) as SessionEvent,
      );
      await rdb(ctx).append(SessionIdBrand("src"), continuation);
      const continued = await rdb(ctx).load(SessionIdBrand("src"));
      expect(continued.events.at(-1)?.type).toBe("turn/end");

      const meter = new TokenMeter(ctx);
      const replayed = Session.create(SessionIdBrand("src"), [...continued.events]);
      expect(() => meter.measure(replayed)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("edits the second user message appended mid-turn in an open turn (agent-loop followup)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
        { type: "step/start", seq: SessionSeq(13), time: 13, data: { turn: 3, step: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(14),
          time: 14,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        {
          type: "assistant/message",
          seq: SessionSeq(15),
          time: 15,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(16), time: 16, data: { turn: 3, step: 1 } },
        { type: "step/start", seq: SessionSeq(17), time: 17, data: { turn: 3, step: 2 } },
        {
          type: "user/message",
          seq: SessionSeq(18),
          time: 18,
          data: {
            id: "turn3-followup",
            role: "user",
            content: [{ type: "text", text: "Llm 请求参数配置不完整" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(19), time: 19, data: { turn: 3, step: 2 } },
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 18,
        blockIndex: 0,
        text: "Llm 请求参数配置不完整（已编辑）",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));
      expect(result.queuedTurns).toBe(0);

      const backend = (
        ctx.sessionPersistence as unknown as {
          internals(): {
            backend: {
              getEventRows(
                id: SessionIdBrand,
              ): Promise<Array<{ fSequence: number; fType: string }>>;
            };
          };
        }
      ).internals().backend;
      const rows = await backend.getEventRows(SessionIdBrand("src"));
      expect(rows.map((r) => r.fSequence)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
      ]);
      expect(rows[17]?.fType).toBe("session-branch/version");
      expect(rows.some((r) => r.fType === "step/start" && r.fSequence === 17)).toBe(false);
      expect(rows.some((r) => r.fType === "user/message" && r.fSequence === 18)).toBe(false);
      expect(rows.some((r) => r.fType === "step/end" && r.fSequence === 19)).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("edits the first user message of an open turn and keeps the mid-turn followup in the replay", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      const second = oneTurnLog().map(
        (e) =>
          ({
            ...e,
            seq: e.seq + 7,
            time: e.time + 100,
            data: { ...e.data, turn: 2 },
          }) as SessionEvent,
      );
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(13), time: 13, data: { turn: 3 } },
        { type: "step/start", seq: SessionSeq(14), time: 14, data: { turn: 3, step: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(15),
          time: 15,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        {
          type: "assistant/message",
          seq: SessionSeq(16),
          time: 16,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(17), time: 17, data: { turn: 3, step: 1 } },
        { type: "step/start", seq: SessionSeq(18), time: 18, data: { turn: 3, step: 2 } },
        {
          type: "user/message",
          seq: SessionSeq(19),
          time: 19,
          data: {
            id: "turn3-followup",
            role: "user",
            content: [{ type: "text", text: "Llm 请求参数配置不完整" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(20), time: 20, data: { turn: 3, step: 2 } },
      ];
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [header, ...first, ...second, ...openTail],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const followups: unknown[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("live")
            ? {
                session: live,
                followup: (message: unknown) => {
                  followups.push(message);
                },
                whenIdle: async () => {},
                inbox: { clear: () => {} },
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 15,
        blockIndex: 0,
        text: "go on (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));

      expect(followups).toHaveLength(2);
      const texts = followups.map((m) =>
        (m as { content: Array<{ type: string; text?: string }> }).content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
      );
      expect(texts).toEqual(["go on (edited)", "Llm 请求参数配置不完整"]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("edits a mid-turn followup of a CLOSED turn without deleting the whole turn", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      const turn2: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(7), time: 8, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(8), time: 9, data: { turn: 2, step: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(9),
          time: 10,
          data: {
            id: "turn2-user",
            role: "user",
            content: [{ type: "text", text: "q1" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        {
          type: "assistant/message",
          seq: SessionSeq(10),
          time: 11,
          data: {
            turn: 2,
            step: 1,
            message: {
              id: "turn2-assistant",
              role: "assistant",
              content: [{ type: "text", text: "ans0" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(11), time: 12, data: { turn: 2, step: 1 } },
        { type: "step/start", seq: SessionSeq(12), time: 13, data: { turn: 2, step: 2 } },
        {
          type: "user/message",
          seq: SessionSeq(13),
          time: 14,
          data: {
            id: "turn2-followup",
            role: "user",
            content: [{ type: "text", text: "followup" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(14), time: 15, data: { turn: 2, step: 2 } },
        {
          type: "turn/end",
          seq: SessionSeq(15),
          time: 16,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await createPersisted(ctx, "src", [header, ...first, ...turn2]);

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 13,
        blockIndex: 0,
        text: "followup (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));

      const after = await rdb(ctx).load(SessionIdBrand("src"));
      const outline = after.events
        .filter((e) =>
          ["turn/start", "turn/end", "user/message", "assistant/message"].includes(e.type),
        )
        .map((e) => `${String(e.seq)}:${e.type.replace("/", ".")}`);

      expect(outline).toContain("6:turn.end");
      expect(outline).toContain("7:turn.start");
      expect(outline).toContain("9:user.message");
      expect(outline).toContain("10:assistant.message");

      expect(
        after.events.some(
          (e) =>
            e.type === "user/message" &&
            (e.data as { content?: Array<{ text?: string }> }).content?.[0]?.text === "q1",
        ),
      ).toBe(true);

      expect(
        after.events.some(
          (e) =>
            e.type === "user/message" &&
            (e.data as { content?: Array<{ text?: string }> }).content?.[0]?.text === "followup",
        ),
      ).toBe(false);

      const completed = after.events.filter(
        (e) =>
          e.type === "turn/end" &&
          (e.data as { reason?: { kind?: string } }).reason?.kind === "completed",
      );
      expect(completed.map((e) => e.seq)).toEqual([6]);
    } finally {
      await dispose();
    }
  });

  it("edits on a COLD session by resuming the agent and replaying the edited input (GUI flow)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      const second = oneTurnLog().map(
        (e) =>
          ({
            ...e,
            seq: e.seq + 7,
            time: e.time + 100,
            data: { ...e.data, turn: 2 },
          }) as SessionEvent,
      );
      await createPersisted(ctx, "cold", [header, ...first, ...second]);
      expect(ctx.sessions.get(SessionIdBrand("cold"))).toBeUndefined();

      const resumed: Array<{
        sessionId: string;
        provider: string | undefined;
        model: string | undefined;
      }> = [];
      const followups: unknown[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: () => undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async (options: {
          resumeSessionId: string;
          agentOptions?: { provider: string; model: string };
        }) => {
          resumed.push({
            sessionId: options.resumeSessionId,
            provider: options.agentOptions?.provider,
            model: options.agentOptions?.model,
          });

          const stored = await rdb(ctx).load(SessionIdBrand("cold"));
          ctx.sessions.create(SessionIdBrand("cold"), {
            meta: stored.meta,
            seed: [...stored.events],
          });
          return {
            agent: {
              session: ctx.sessions.get(SessionIdBrand("cold"))!,
              followup: (message: unknown) => {
                followups.push(message);
              },
            },
            dispose: async () => {},
          };
        },
      });

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("cold"),
        eventSeq: 8,
        blockIndex: 0,
        text: "q2 edited",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("cold"));

      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ sessionId: "cold", provider: "mock", model: "mock" });

      expect(followups).toHaveLength(1);
      const text = (followups[0] as { content: Array<{ type: string; text?: string }> }).content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      expect(text).toBe("q2 edited");

      expect(ctx.sessions.get(SessionIdBrand("cold"))).toBeDefined();
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("surfaces a resume failure instead of silently dropping the edited replay", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      await createPersisted(ctx, "cold2", [header, ...first]);

      const disposeAgents = ctx.provide("agents", {
        get: () => undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("no agent factory registered");
        },
      });

      await expect(
        editor.edit({
          action: "edit",
          sessionId: SessionIdBrand("cold2"),
          eventSeq: 2,
          blockIndex: 0,
          text: "edited q1",
          cascade: "truncate",
        }),
      ).rejects.toThrow(/no agent factory registered|无法重放/);
      const after = await rdb(ctx).load(SessionIdBrand("cold2"));
      expect(after.events).toHaveLength(7);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("stops a busy live agent's loop before rewinding (edit cancels the run first)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("busy"), {
        meta: meta("busy"),
        seed: [header, ...first],
      });
      const live = ctx.sessions.get(SessionIdBrand("busy"))!;
      await ctx.sessions.flush(live);
      const before = live.snapshotEvents().length;

      let releaseIdle: () => void = () => {};
      const idlePromise = new Promise<void>((resolve) => {
        releaseIdle = resolve;
      });
      const calls: string[] = [];
      const cancels: Array<{ cause: unknown; options: unknown }> = [];
      const followups: unknown[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("busy")
            ? {
                session: live,
                followup: (message: unknown) => {
                  followups.push(message);
                },
                cancel: (cause: unknown, options: unknown) => {
                  calls.push("cancel");
                  cancels.push({ cause, options });
                },
                whenIdle: () => {
                  calls.push("whenIdle");
                  return idlePromise;
                },
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      const editing = editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("busy"),
        eventSeq: 2,
        blockIndex: 0,
        text: "edited while busy",
        cascade: "truncate",
      });

      for (let i = 0; i < 1000 && !calls.includes("whenIdle"); i += 1) await Promise.resolve();
      expect(calls).toEqual(["cancel", "whenIdle"]);

      expect(cancels[0]).toEqual({ cause: { kind: "user" }, options: { keepInbox: true } });
      expect(live.snapshotEvents()).toHaveLength(before);

      releaseIdle();
      const result = await editing;
      expect(result.sessionId).toBe(SessionIdBrand("busy"));
      expect(result.queuedTurns).toBe(1);
      expect(followups).toHaveLength(1);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("rewind durably cancels the live agent's leftover queued input", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as unknown as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("pending"), {
        meta: meta("pending"),
        seed: [header, ...first],
      });
      const live = ctx.sessions.get(SessionIdBrand("pending"))!;
      await ctx.sessions.flush(live);

      let cleared = false;
      const followups: unknown[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("pending")
            ? {
                session: live,
                followup: (message: unknown) => {
                  followups.push(message);
                },
                whenIdle: async () => {},
                inbox: {
                  clear: () => {
                    cleared = true;
                  },
                },
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("pending"),
        eventSeq: 2,
        blockIndex: 0,
        text: "edited with pending inbox",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("pending"));
      expect(cleared).toBe(true);
      expect(followups).toHaveLength(1);
      disposeAgents();
    } finally {
      await dispose();
    }
  });
});
