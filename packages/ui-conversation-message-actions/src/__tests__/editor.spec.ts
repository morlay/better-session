/**
 * 编排层测试：闭合轮次折叠 / 编辑面枚举（纯函数）与 retry / rewind / fork /
 * timeline 的端到端编排（装配真实 rdb 后端 + branch provider）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import {
  Session,
  SessionId as SessionIdBrand,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { type BranchTimeline } from "@morlay/session-branch";
import SessionPersistenceSqlite from "../../../session-rdb/src/index.ts";
import { EmptySettings } from "../../../session-rdb/src/__tests__/testing/helpers.ts";
import { meta, oneTurnLog } from "../../../session-rdb/src/__tests__/testing/contract.ts";
import { SessionEditor, closedTurns, editableMessages, retryableTurns } from "../index.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** 装配：SessionStore + rdb persistence + sessionBranch + sessionEditor。 */
async function harness(): Promise<{
  ctx: Context;
  editor: SessionEditor;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  await ctx.plugin(SessionEditor);
  return { ctx, editor: ctx.sessionEditor, dispose: () => fiber.dispose() };
}

/** 两轮闭合会话（轮 1: seq 0..5，轮 2: seq 6..11）。 */
function twoTurnLog(): SessionEvent[] {
  const first = oneTurnLog();
  const second: SessionEvent[] = oneTurnLog().map(
    (event) =>
      ({
        ...event,
        seq: event.seq + 6,
        time: event.time + 100,
        data: { ...event.data, turn: 2 },
      }) as SessionEvent,
  );
  return [...first, ...second];
}

async function createPersisted(
  ctx: Context,
  id: string,
  events: readonly SessionEvent[],
  header: SessionHeader = meta(id),
): Promise<void> {
  await ctx.sessionPersistence.create(header);
  await ctx.sessionPersistence.append(SessionIdBrand(id), [...events]);
}

describe("closedTurns / editableMessages / retryableTurns", () => {
  const log = twoTurnLog();

  it("folds two complete turns", () => {
    const turns = closedTurns(log);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(turns[0]?.startSeq).toBe(0);
    expect(turns[0]?.endSeq).toBe(5);
    expect(turns[1]?.startSeq).toBe(6);
    expect(turns[1]?.endSeq).toBe(11);
  });

  it("enumerates editable user/assistant text blocks", () => {
    const blocks = editableMessages(closedTurns(log));
    expect(blocks.filter((b) => b.kind === "user")).toHaveLength(2);
    expect(blocks.filter((b) => b.kind === "assistant.response")).toHaveLength(2);
  });

  it("enumerates retryable turns with user previews", () => {
    const turns = retryableTurns(closedTurns(log));
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(turns[0]?.preview).toBe("hi");
  });
});

describe("SessionEditor rewind/retry/fork", () => {
  it("retry truncates the original session in place (same session id)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      const result = await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("src"),
        turn: 2,
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("src")); // 不改变 session id
      expect(result.queuedTurns).toBe(0); // 无 agents 服务 → 退化为就地版本

      const after = await ctx.sessionPersistence.load(SessionIdBrand("src"));
      // 截断到轮 1（turn/end @ 5），轮 2 及之后被抛弃；版本效果 ignorable 不落库。
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      await dispose();
    }
  });

  it("rewind truncates the original session and allows continuation", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      await editor.rewind(SessionIdBrand("src"), 5);
      const after = await ctx.sessionPersistence.load(SessionIdBrand("src"));
      expect(after.events).toHaveLength(6);
      expect(after.events.at(-1)?.type).toBe("turn/end");
      // 续写（coordinator 状态已同步）。
      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 6,
            time: event.time + 200,
            data: { ...event.data, turn: 2 },
          }) as SessionEvent,
      );
      await ctx.sessionPersistence.append(SessionIdBrand("src"), continuation);
      expect(await ctx.sessionPersistence.load(SessionIdBrand("src"))).toMatchObject({});
    } finally {
      await dispose();
    }
  });

  it("rewinds a live session in place (memory log truncated too)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      ctx.sessions.create(SessionIdBrand("live"), { meta: meta("live"), seed: [...twoTurnLog()] });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);
      await editor.rewind(SessionIdBrand("live"), 5);
      // live 内存 log 与持久化一起截断，会话不释放、id 不变。
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(ctx.sessions.get(SessionIdBrand("live"))).toBe(live);
    } finally {
      await dispose();
    }
  });

  it("retry on a live session keeps the version effect in memory but not in storage", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      ctx.sessions.create(SessionIdBrand("live"), { meta: meta("live"), seed: [...twoTurnLog()] });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const result = await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("live"),
        turn: 2,
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));

      // live 内存 log：截断前缀 + ignorable 版本效果（seq 6）。
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(live.events[6]?.type).toBe("session-branch/version");
      // RDB canonical log：只有截断前缀（版本效果 ignorable 不落库）。
      const backend = (
        ctx.sessionPersistence as unknown as {
          internals(): {
            backend: { getHead(id: SessionIdBrand): Promise<{ fHeadSequence: number }> };
          };
        }
      ).internals().backend;
      const head = await backend.getHead(SessionIdBrand("live"));
      expect(head.fHeadSequence).toBe(5);
    } finally {
      await dispose();
    }
  });

  it("edits after an interrupted run (open turn with delta events) without misreading the stored head", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // 轮 1（seq 0..5）+ 轮 2（seq 6..11）闭合，轮 3 流式输出中途停止：
      // turn/start + user/message + step/start + 大量 assistant/chunk（delta，
      // 落盘时被 RDB 过滤）+ assistant/message + step/end，没有 turn/end。
      const chunk = (seq: number, text: string): SessionEvent => ({
        type: "assistant/chunk",
        seq,
        time: seq,
        data: { turn: 3, step: 1, chunk: { type: "text-delta", index: 0, text } },
      });
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: 12, time: 12, data: { turn: 3 } },
        {
          type: "user/message",
          seq: 13,
          time: 13,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/start", seq: 14, time: 14, data: { turn: 3, step: 1 } },
        chunk(15, "a"),
        chunk(16, "b"),
        chunk(17, "c"),
        {
          type: "assistant/message",
          seq: 18,
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
        { type: "step/end", seq: 19, time: 19, data: { turn: 3, step: 1 } },
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
      expect(live.events.at(-1)?.seq).toBe(20);
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
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(live.events[6]?.type).toBe("session-branch/version");
      expect(live.events.at(-1)?.type).toBe("turn/end");
      // RDB canonical log：截断前缀 + 手工轮（版本效果 ignorable 不落库）→ head = 11。
      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(11);

      // 截断后继续 append 成功（coordinator cursor 已对齐，无残留 writer 校验误报）。
      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      liveAppend.append("turn/start", { turn: 4 });
      await ctx.sessions.flush(live);
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect((await backend.getHead(SessionIdBrand("live"))).fHeadSequence).toBe(12);
    } finally {
      await dispose();
    }
  });

  it("retry on a live session replays queued input through the live agent", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // 轮 1（seq 1..6）+ request/header（seq 0，在轮 1 内，截断后仍可解析模型）
      // + 轮 2（seq 7..12）。
      const first = oneTurnLog().map(
        (e) => ({ ...e, seq: e.seq + 1, time: e.time + 1 }) as SessionEvent,
      );
      const header: SessionEvent = {
        type: "request/header",
        seq: 0,
        time: 1,
        data: {
          header: { config: { provider: "mock", model: "mock" } },
          reason: "initial",
        },
      } as SessionEvent;
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
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      const result = await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("live"),
        turn: 2,
        cascade: "truncate",
      });
      // 就地：id 不变；重放排队到 live agent（turn 2 的输入）。
      expect(result.sessionId).toBe(SessionIdBrand("live"));
      expect(followups).toHaveLength(1);
      // live log：截断前缀（header seq 0 + 轮 1 seq 1..6）+ ignorable
      // 版本效果（seq 7，boundary = 轮 1 的 turn/end @ 6）。
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(live.events[7]?.type).toBe("session-branch/version");
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("edits an assistant block on a live session (manualTurn lands, cursor synced)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: 0,
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
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(live.events[7]?.type).toBe("session-branch/version");
      expect(live.events.at(-1)?.type).toBe("turn/end");
      // manualTurn 的 assistant 内容为编辑后文本。
      const editedAssistant = live.events.find(
        (e) => e.type === "assistant/message" && e.data.turn === 2,
      );
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
        seq: 0,
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
      expect(live.events.map((e) => e.seq)).toEqual([0]);
      expect(live.events[0]?.type).toBe("session-branch/version");
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("rewind resets the live agent's turn cursor so replay reuses the turn number", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const header: SessionEvent = {
        type: "request/header",
        seq: 0,
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

      // mock 驻留 agent：phase.lastTurn = 2（编辑前游标），requestHeaderLogged = true。
      const mockAgent: {
        session: typeof live;
        requestHeaderLogged: boolean;
        phase: { lastTurn: number };
        followup: () => void;
      } = { session: live, requestHeaderLogged: true, phase: { lastTurn: 2 }, followup: () => {} };
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) => (id === SessionIdBrand("live") ? mockAgent : undefined),
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      // retry turn 2（truncate → 截断到轮 1 末尾，保留轮 1 = turn 1）。
      const result = await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("live"),
        turn: 2,
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));
      // 轮次游标重置为截断后最后 turn 号（轮 1 = 1）→ 重放 followup 会开
      // turn 2（复用目标轮号），而不是递增出 turn 3。
      expect(mockAgent.phase.lastTurn).toBe(1);
      expect(mockAgent.requestHeaderLogged).toBe(false);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("fork derives a child at a closed boundary", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      const childId = await editor.fork(SessionIdBrand("src"), 6, SessionIdBrand("child"));
      expect(childId).toBe(SessionIdBrand("child"));
      const child = await ctx.sessionPersistence.load(childId);
      expect(child.meta.parentSession).toBe(SessionIdBrand("src"));
      expect(child.events).toHaveLength(12); // after 模式：包含轮 2
    } finally {
      await dispose();
    }
  });

  it("timeline keeps a single root after in-place retry", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("src"),
        turn: 2,
        cascade: "truncate",
      });
      const timeline: BranchTimeline = await editor.timeline(SessionIdBrand("src"));
      expect(timeline.root.sessionId).toBe(SessionIdBrand("src"));
      // 就地编辑不派生新会话：版本树保持单根。
      expect(timeline.nodes).toHaveLength(1);
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
        { type: "turn/start", seq: 12, time: 12, data: { turn: 3 } },
        {
          type: "user/message",
          seq: 13,
          time: 13,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/start", seq: 14, time: 14, data: { turn: 3, step: 1 } },
        {
          type: "assistant/message",
          seq: 15,
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
        { type: "turn/start", seq: 12, time: 12, data: { turn: 3 } },
        {
          type: "user/message",
          seq: 13,
          time: 13,
          data: {
            id: "turn3-user",
            role: "user",
            content: [{ type: "text", text: "go on" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as SessionEvent,
        { type: "step/start", seq: 14, time: 14, data: { turn: 3, step: 1 } },
        {
          type: "assistant/message",
          seq: 15,
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
        { type: "turn/start", seq: 12, time: 12, data: { turn: 3 } },
        { type: "step/start", seq: 13, time: 13, data: { turn: 3, step: 1 } },
        {
          type: "user/message",
          seq: 14,
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
          seq: 15,
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
        { type: "step/end", seq: 16, time: 16, data: { turn: 3, step: 1 } },
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
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(live.events[12]?.type).toBe("turn/start");
      expect(live.events[13]?.type).toBe("session-branch/version");
      expect(live.events.some((e) => e.type === "step/start" && e.data.turn === 3)).toBe(false);
      // 内存 log 对 token meter 重放合法。
      const meter = new TokenMeter(ctx);
      expect(() => meter.measure(live)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("cleanseSession rewrites legacy provenance coordinates so the session reloads", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // append 时事件 seq 是上游坐标（delta 被过滤后稠密重编号），replace 的
      // sourceEventSeqs/surfaceOp 原样落库为上游坐标——历史加载失败的数据样式。
      const compacted: SessionEvent[] = [
        { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
        {
          type: "user/message",
          seq: 1,
          time: 2,
          data: {
            id: "cleanse-user",
            role: "user",
            content: [{ type: "text", text: "hi" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as SessionEvent,
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
            message: {
              id: "turn1-assistant",
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          surfaceOp: "append",
        } as SessionEvent,
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
        { type: "step/end", seq: 11, time: 12, data: { turn: 2, step: 1 } },
        { type: "turn/end", seq: 12, time: 13, data: { turn: 2, reason: { kind: "completed" } } },
      ];
      await createPersisted(ctx, "cleanse-me", compacted);

      // 清洗：坐标重写为稠密空间。
      const { changed } = await editor.cleanseSession(SessionIdBrand("cleanse-me"));
      expect(changed).toBeGreaterThan(0);

      // 清洗后会话可完整加载。
      const after = await ctx.sessionPersistence.load(SessionIdBrand("cleanse-me"));
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
        seq,
        time: seq,
        data: { turn: 3, step: 1, chunk: { type: "text-delta", index: 0, text } },
      });
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: 12, time: 12, data: { turn: 3 } },
        { type: "step/start", seq: 13, time: 13, data: { turn: 3, step: 1 } },
        {
          type: "user/message",
          seq: 14,
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
          seq: 17,
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
        { type: "step/end", seq: 18, time: 18, data: { turn: 3, step: 1 } },
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
});
