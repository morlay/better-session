/**
 * 编排层测试：闭合轮次折叠 / 编辑面枚举（纯函数）与 retry / rewind / fork /
 * timeline 的端到端编排（装配真实 rdb 后端 + branch provider）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { SessionId as SessionIdBrand, SessionStore } from "@deepseek-ai/dsh-session";
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
});
