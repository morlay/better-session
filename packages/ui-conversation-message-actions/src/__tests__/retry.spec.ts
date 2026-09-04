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
  type BranchTimeline,
  type SessionEvent,
} from "@morlay/ui-conversation-message-actions/testing";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("SessionEditor retry", () => {
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
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(live.snapshotEvents()[6]?.type).toBe("session-branch/version");
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
        seq: SessionSeq(0),
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
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(live.snapshotEvents()[7]?.type).toBe("session-branch/version");
      disposeAgents();
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
});
