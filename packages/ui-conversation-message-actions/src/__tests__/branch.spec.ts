import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  createPersisted,
  harness,
  meta,
  oneTurnLog,
  twoTurnLog,
  SessionIdBrand,
  SessionSeq,
  type SessionEvent,
} from "@morlay/ui-conversation-message-actions/testing";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("SessionEditor rewind / fork / timeline", () => {
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
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(ctx.sessions.get(SessionIdBrand("live"))).toBe(live);
    } finally {
      await dispose();
    }
  });

  it("rewind resets the live agent's turn cursor so replay reuses the turn number", async () => {
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

      // mock 驻留 agent：phase.lastTurn = 2（编辑前游标），requestHeaderLogged = true。
      const mockAgent: {
        session: typeof live;
        requestHeaderLogged: boolean;
        phase: { lastTurn: number };
        followup: () => void;
        whenIdle: () => Promise<void>;
        inboxPending: boolean;
        clearInbox: () => void;
      } = {
        session: live,
        requestHeaderLogged: true,
        phase: { lastTurn: 2 },
        followup: () => {},
        whenIdle: async () => {},
        inboxPending: false,
        clearInbox: () => {},
      };
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
});
