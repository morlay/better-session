import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
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

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("SessionEditor edit", () => {
  it("edits after an interrupted run (open turn with delta events) without misreading the stored head", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // 轮 1（seq 0..5）+ 轮 2（seq 6..11）闭合，轮 3 流式输出中途停止：
      // turn/start + user/message + step/start + 大量 assistant/chunk（delta，
      // 落盘时被 RDB 过滤）+ assistant/message + step/end，没有 turn/end。
      const chunk = (seq: number, text: string): SessionEvent => ({
        type: "assistant/chunk",
        seq: SessionSeq(seq),
        time: seq,
        data: { turn: 3, step: 1, chunk: { type: "text-delta", index: 0, text } },
      });
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
        } as SessionEvent,
        { type: "step/start", seq: SessionSeq(14), time: 14, data: { turn: 3, step: 1 } },
        chunk(15, "a"),
        chunk(16, "b"),
        chunk(17, "c"),
        {
          type: "assistant/message",
          seq: SessionSeq(18),
          time: 18,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(19), time: 19, data: { turn: 3, step: 1 } },
      ];
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [...twoTurnLog(), ...openTail],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      // live 上游 head = 20（含构造时自动补记的 session/end-seed）；
      // RDB 稠密 head = 17（3 个 delta 被过滤，end-seed 落盘）。
      const backend = (
        ctx.sessionPersistence as unknown as {
          internals(): {
            backend: { getHead(id: SessionIdBrand): Promise<{ fHeadSequence: number }> };
          };
        }
      ).internals().backend;
      expect(live.snapshotEvents().at(-1)?.seq).toBe(20);
      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(17);

      // 编辑轮 2 的助手文本 → boundary = 轮 1 的 turn/end（上游 seq 5）。
      // 修复前：上游 seq 与稠密 head 直接比较 → 误报
      // "rewind boundary 5 is beyond the stored head 17"。
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

      // live 内存 log：截断前缀（0..5）+ ignorable 版本效果（6）+ 手工闭合轮（7..12）。
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(live.snapshotEvents()[6]?.type).toBe("session-branch/version");
      expect(live.snapshotEvents().at(-1)?.type).toBe("turn/end");
      // RDB canonical log：截断前缀 + 手工轮（版本效果 ignorable 不落库）→ head = 11。
      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(11);

      // 截断后继续 append 成功（coordinator cursor 已对齐，无残留 writer 校验误报）。
      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      liveAppend.append("turn/start", { turn: 4 });
      await ctx.sessions.flush(live);
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(12);
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
      } as SessionEvent;
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

      // 编辑轮 2 的 assistant（eventSeq 10 = 轮 2 assistant/message）→ manualTurn。
      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 10,
        blockIndex: 0,
        text: "第二轮回答（已编辑）",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));

      // live log：截断前缀（header + 轮 1，seq 0..6）+ ignorable 版本效果
      // （seq 7）+ manualTurn 轮 2（seq 8..13，含 turn/start…turn/end）。
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      expect(live.snapshotEvents()[7]?.type).toBe("session-branch/version");
      expect(live.snapshotEvents().at(-1)?.type).toBe("turn/end");
      // manualTurn 的 assistant 内容为编辑后文本。
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
      } as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("live"), { meta: meta("live"), seed: [header, ...first] });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      // mock agents：get 返回 live agent（记录 followup）。
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
                inboxPending: false,
                clearInbox: () => {},
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      // 编辑轮 1 的 user（eventSeq 2）→ boundary = -1（清空全部，含
      // request/header）→ 重放输入必须经 rewind 前解析的 headerConfig 排队。
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
      // live log：版本效果（seq 0）+ 重放输入由 followup 后的 agent append
      // （mock 只记录，不 append）→ 版本效果是唯一新事件。
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

  it("edits a user message in an open turn (rewind to the message, drop and replay)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // 轮 1（seq 0..5 闭合）+ 轮 2（seq 6..11 闭合）+ 轮 3 未闭合：
      // turn/start + user/message（seq 12）+ step/start + assistant/message（seq 14）。
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
        } as SessionEvent,
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
          },
          surfaceOp: "append",
        } as SessionEvent,
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      // 编辑未闭合轮 3 的 user 消息（eventSeq 13）→ rewind 到该消息
      // （exclusive drop 它及其后），重放编辑版。
      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 13,
        blockIndex: 0,
        text: "go on (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));
      expect(result.queuedTurns).toBe(0); // 无 agents 服务 → 退化为就地版本

      // 真实落盘行：截断前缀（0..12，含 turn/start 12）；版本效果 ignorable
      // 不落库；无 agents 服务 → 重放输入不落盘（退化为已 durable 的就地
      // 版本，可随时继续输入）。
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
      expect(rows[12]?.fType).toBe("turn/start");
      // 被 drop 的旧 user/message（seq 13）与轮 3 partial assistant（seq 15）
      // 不在 log 中（轮 1/2 的 assistant/message 保留）。
      expect(rows.some((r) => r.fType === "user/message" && r.fSequence === 13)).toBe(false);
      expect(rows.some((r) => r.fType === "assistant/message" && r.fSequence === 15)).toBe(false);
      expect(rows.some((r) => r.fType === "assistant/message" && r.fSequence === 3)).toBe(true);

      // 截断后继续 append 成功：版本效果（ignorable）占 seq 13 推进 cursor，
      // 后续输入从 seq 14 续接（落盘时 ignorable 被过滤、稠密重编号连续）。
      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 14,
            time: event.time + 300,
            data: { ...event.data, turn: 3 },
          }) as SessionEvent,
      );
      await ctx.sessionPersistence.append(SessionIdBrand("src"), continuation);
      const continued = await ctx.sessionPersistence.load(SessionIdBrand("src"));
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
        } as SessionEvent,
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
          },
          surfaceOp: "append",
        } as SessionEvent,
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
      // 轮 1（seq 0..5 闭合）+ 轮 2（seq 6..11 闭合）+ 轮 3 未闭合，真实
      // agent-loop 顺序：turn/start → step/start → user/message → ...
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
        } as SessionEvent,
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
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(16), time: 16, data: { turn: 3, step: 1 } },
      ];
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [...twoTurnLog(), ...openTail],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      // 编辑未闭合轮 3 的 user 消息（eventSeq 14）→ rewind 到该消息
      // （exclusive drop 它及其后）。真实顺序下 step/start（13）在
      // user/message 之前，会残留为孤儿——修复前 live 内存 log 对 token
      // meter 重放非法。
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

      // live 内存 log：截断前缀（0..12，孤儿 step/start 13 被剔除）+
      // ignorable 版本效果（13）。
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      expect(live.snapshotEvents()[12]?.type).toBe("turn/start");
      expect(live.snapshotEvents()[13]?.type).toBe("session-branch/version");
      expect(live.snapshotEvents().some((e) => e.type === "step/start" && e.data.turn === 3)).toBe(
        false,
      );
      // 内存 log 对 token meter 重放合法。
      const meter = new TokenMeter(ctx);
      expect(() => meter.measure(live)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("exports a surface-corrupt session as a loadable artifact (export-time repair)", async () => {
    const { ctx, dispose } = await harness();
    try {
      // 历史加载失败的数据样式：append 时事件 seq 是上游坐标（delta 被过滤
      // 后稠密重编号），replace 的 sourceEventSeqs/surfaceOp 原样落库为上游
      // 坐标；且 tool/result replace 指向的当前 surface 节点不是 tool/result
      // （上游 assertToolResultRewrite 校验失败）——load 抛 invalid seed。
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
        } as SessionEvent,
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
            message: {
              id: "turn1-assistant",
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          surfaceOp: "append",
        } as SessionEvent,
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
            message: {
              id: "compacted",
              role: "assistant",
              content: [{ type: "text", text: "compacted" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          surfaceOp: { op: "replace", start: 1, end: 5 },
          sourceEventSeqs: [1, 5],
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(11), time: 12, data: { turn: 2, step: 1 } },
        {
          type: "turn/end",
          seq: SessionSeq(12),
          time: 13,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await createPersisted(ctx, "export-me", compacted);

      // 导出即修复：readRaw 序列化前修复 surface 语义并重算 provenance，
      // 产出的 artifact 无需任何修复即可导入。
      const raw = await ctx.sessionPersistence.readRaw(SessionIdBrand("export-me"));
      expect(raw).toBeDefined();
      const parsed = parseJsonlArtifact(raw!.content);
      // 导入以新 id 落库后会话可完整加载。
      const importedId = SessionIdBrand("export-imported");
      await ctx.sessionPersistence.create(
        { ...parsed.meta, id: importedId },
        parsed.inheritedEventCount,
      );
      await ctx.sessionPersistence.append(importedId, parsed.events);
      const after = await ctx.sessionPersistence.load(importedId);
      expect(after.events.at(-1)?.type).toBe("turn/end");
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await dispose();
    }
  });

  it("edits a user message in an open turn in real agent-loop order (orphan step/start dropped, token-meter replay safe)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // 真实 agent-loop 的 append 顺序：turn/start → step/start → user/message
      // → assistant/chunk（delta，落盘被过滤）→ assistant/message → step/end
      // （无 turn/end）。轮 1（seq 0..5）+ 轮 2（seq 6..11）闭合，轮 3 未闭合。
      const chunk = (seq: number, text: string): SessionEvent => ({
        type: "assistant/chunk",
        seq: SessionSeq(seq),
        time: seq,
        data: { turn: 3, step: 1, chunk: { type: "text-delta", index: 0, text } },
      });
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
        } as SessionEvent,
        chunk(15, "a"),
        chunk(16, "b"),
        {
          type: "assistant/message",
          seq: SessionSeq(17),
          time: 17,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "turn3-assistant",
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(18), time: 18, data: { turn: 3, step: 1 } },
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      // 编辑未闭合轮 3 的 user 消息（eventSeq 14）→ rewind 到该消息
      // （exclusive drop 它及其后）。真实顺序下 step/start（13）在
      // user/message 之前，会残留为孤儿——修复前续写落盘后 token meter
      // 重放报 "step/start ... arrived before turn ... ended"。
      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 14,
        blockIndex: 0,
        text: "go on (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));
      expect(result.queuedTurns).toBe(0); // 无 agents 服务 → 退化为就地版本

      // 真实落盘行：截断前缀（0..12，含 turn/start 12，孤儿 step/start 13
      // 被剔除）；版本效果 ignorable 不落库。
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
      expect(rows[12]?.fType).toBe("turn/start");
      expect(rows.some((r) => r.fType === "step/start" && r.fSequence === 13)).toBe(false);

      // 截断后继续 append 成功：版本效果（ignorable）占 seq 13 推进 cursor，
      // 后续输入从 seq 14 续接（落盘时 ignorable 被过滤、稠密重编号连续）。
      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 14,
            time: event.time + 300,
            data: { ...event.data, turn: 3 },
          }) as SessionEvent,
      );
      await ctx.sessionPersistence.append(SessionIdBrand("src"), continuation);
      const continued = await ctx.sessionPersistence.load(SessionIdBrand("src"));
      expect(continued.events.at(-1)?.type).toBe("turn/end");
      // 完整 log 对 token meter 重放合法（无孤儿 step/start）。
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
      // 轮 1（seq 0..5 闭合）+ 轮 2（seq 6..11 闭合）+ 轮 3 未闭合，且轮 3
      // 内 agent 运行中追加了第二条 user/message（真实 agent-loop 的 followup
      // 追加：turn/start → step/start → user/message → assistant/message →
      // step/end → step/start → user/message → step/end，无 turn/end）。
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
        } as SessionEvent,
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
          },
          surfaceOp: "append",
        } as SessionEvent,
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
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(19), time: 19, data: { turn: 3, step: 2 } },
      ];
      await createPersisted(ctx, "src", [...twoTurnLog(), ...openTail]);

      // 编辑轮 3 内追加的第二条 user 消息（eventSeq 18）→ rewind 到该消息
      // （exclusive drop 它及其后），重放编辑版。
      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 18,
        blockIndex: 0,
        text: "Llm 请求参数配置不完整（已编辑）",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));
      expect(result.queuedTurns).toBe(0); // 无 agents 服务 → 退化为就地版本

      // 真实落盘行：截断前缀（0..16，孤儿 step/start 17 被 balanceRewindPrefix
      // 剔除——它配对的 step/end 19 已被 drop）；版本效果 ignorable 不落库；
      // 被 drop 的旧 followup（seq 18）与 step/end（19）不在 log 中。
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
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ]);
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
      // request/header（seq 0）+ 轮 1（seq 1..6 闭合）+ 轮 2（seq 7..12 闭合）
      // + 轮 3 未闭合，轮 3 内 agent 运行中追加了第二条 user/message（followup）。
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as SessionEvent;
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
        } as SessionEvent,
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
          },
          surfaceOp: "append",
        } as SessionEvent,
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
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(20), time: 20, data: { turn: 3, step: 2 } },
      ];
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [header, ...first, ...second, ...openTail],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      // mock agents：get 返回 live agent（记录 followup，不真正驱动模型）。
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
                inboxPending: false,
                clearInbox: () => {},
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      // 编辑轮 3 的第一条 user 消息（eventSeq 15）→ rewind 到该消息
      // （exclusive drop 它及其后），重放编辑版 + 轮内 followup。
      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 15,
        blockIndex: 0,
        text: "go on (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));
      // 重放 2 条输入：编辑版 + 轮内 followup。
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
      // request/header（seq 0）+ 轮 1（seq 1..6 闭合）+ 轮 2（seq 7..15 闭合）
      // 轮 2 内 agent 运行中追加了第二条 user/message（followup）。
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as SessionEvent;
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
        } as SessionEvent,
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
        } as SessionEvent,
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
        } as SessionEvent,
        { type: "step/end", seq: SessionSeq(14), time: 15, data: { turn: 2, step: 2 } },
        {
          type: "turn/end",
          seq: SessionSeq(15),
          time: 16,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await createPersisted(ctx, "src", [header, ...first, ...turn2]);

      // 编辑闭合轮 2 内的 followup（eventSeq 13）→ 只 rewind 到该消息
      // （exclusive drop 它及其后），保留轮首 q1 与回复，绝不允许整轮删除。
      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: 13,
        blockIndex: 0,
        text: "followup (edited)",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src"));

      const after = await ctx.sessionPersistence.load(SessionIdBrand("src"));
      const outline = after.events
        .filter((e) =>
          ["turn/start", "turn/end", "user/message", "assistant/message"].includes(e.type),
        )
        .map((e) => `${String(e.seq)}:${e.type.replace("/", ".")}`);
      // 轮 1 完整保留 + 轮 2 的 turn/start + q1 + ans0 保留；followup
      // 之后（旧 seq 13/14/15）被 drop。
      expect(outline).toContain("6:turn.end");
      expect(outline).toContain("7:turn.start");
      expect(outline).toContain("9:user.message");
      expect(outline).toContain("10:assistant.message");
      // 轮 2 还在（未被整轮删除）：轮首 q1 文本保留；turn/end 已不存在
      // （被截断，load 补合成 interrupted closers）。
      expect(
        after.events.some(
          (e) =>
            e.type === "user/message" &&
            (e.data as { content?: Array<{ text?: string }> }).content?.[0]?.text === "q1",
        ),
      ).toBe(true);
      // followup 文本已不在（exclusive drop 后未重放）。
      expect(
        after.events.some(
          (e) =>
            e.type === "user/message" &&
            (e.data as { content?: Array<{ text?: string }> }).content?.[0]?.text === "followup",
        ),
      ).toBe(false);
      // 轮 2 的真实 turn/end（reason completed）已被截断；load 只给未闭合
      // 尾部补合成 interrupted closers，轮 1 的 completed turn/end 保留。
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
      // request/header（seq 0）+ 轮 1（seq 1..6 闭合）+ 轮 2（seq 7..12 闭合）。
      // 会话只落库、无 live owner（模拟 GUI 打开历史会话后服务端 cold）。
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as SessionEvent;
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
      expect(ctx.sessions.get(SessionIdBrand("cold"))).toBeUndefined(); // 确无 live

      // mock agents：resume 返回一个"已驻留 agent"handle（记录 followup）。
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
        resume: async (options: { resumeSessionId: string; agentOptions?: { provider: string; model: string } }) => {
          resumed.push({
            sessionId: options.resumeSessionId,
            provider: options.agentOptions?.provider,
            model: options.agentOptions?.model,
          });
          // 真实 resume 会加载会话并建立 live entry（读 DB 现有事件）。
          const stored = await ctx.sessionPersistence.load(SessionIdBrand("cold"));
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

      // 编辑轮 2 user（eventSeq 8）→ rewind 到轮 1 末尾 → resume agent →
      // followup 重放 edited 输入（GUI 场景的完整闭环）。
      const result = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("cold"),
        eventSeq: 8,
        blockIndex: 0,
        text: "q2 edited",
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("cold"));
      // resume 被调用且携带会话的模型配置。
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ sessionId: "cold", provider: "mock", model: "mock" });
      // followup 收到编辑后的输入。
      expect(followups).toHaveLength(1);
      const text = (
        followups[0] as { content: Array<{ type: string; text?: string }> }
      ).content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      expect(text).toBe("q2 edited");
      // 会话被 resume 后变 live（agent 驻留）。
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
      } as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      await createPersisted(ctx, "cold2", [header, ...first]);

      // agents 服务存在但 resume 失败（factory 缺失 / prepare 冲突）。
      const disposeAgents = ctx.provide("agents", {
        get: () => undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("no agent factory registered");
        },
      });

      // 编辑轮 1 user（eventSeq 2）：resume 在 rewind 前失败 → 编辑抛错
      // （不静默），且会话未被截断（原子：失败不丢数据）。
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
      const after = await ctx.sessionPersistence.load(SessionIdBrand("cold2"));
      expect(after.events).toHaveLength(7); // header(0) + 轮 1(1..6) 完整
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("waits for a busy live agent to settle BEFORE rewinding (edit stops the run first)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("busy"), {
        meta: meta("busy"),
        seed: [header, ...first],
      });
      const live = ctx.sessions.get(SessionIdBrand("busy"))!;
      await ctx.sessions.flush(live);

      // agent 正在跑（whenIdle 需要显式 resolve 才会放行 rewind）。
      let releaseIdle: () => void = () => {};
      const idlePromise = new Promise<void>((resolve) => {
        releaseIdle = resolve;
      });
      let idleWaited = false;
      const followups: unknown[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("busy")
            ? {
                session: live,
                followup: (message: unknown) => {
                  followups.push(message);
                },
                whenIdle: () => {
                  idleWaited = true;
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

      // 发起编辑（内部会先等 agent idle）——不应在 agent 释放前完成 rewind。
      const editing = editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("busy"),
        eventSeq: 2,
        blockIndex: 0,
        text: "edited while busy",
        cascade: "truncate",
      });
      // 给 microtask 让 whenIdle 被调用。
      await Promise.resolve();
      expect(idleWaited).toBe(true);
      // 释放 agent → 编辑继续完成。
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

  it("clears the live agent inbox before rewinding", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
      } as SessionEvent;
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      ctx.sessions.create(SessionIdBrand("pending"), {
        meta: meta("pending"),
        seed: [header, ...first],
      });
      const live = ctx.sessions.get(SessionIdBrand("pending"))!;
      await ctx.sessions.flush(live);

      // Agent inbox has leftover queued input (rewind would delete its turn).
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
                inboxPending: true,
                clearInbox: () => {
                  cleared = true;
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
      // Rewind only happens after leftover inbox input is cleared.
      expect(cleared).toBe(true);
      expect(followups).toHaveLength(1);
      disposeAgents();
    } finally {
      await dispose();
    }
  });
});
