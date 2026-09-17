import SessionPersistenceSqlite from "@morlay/session-rdb";
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

function rdb(ctx: import("@deepseek-ai/cordis").Context): SessionPersistenceSqlite {
  return ctx.sessionPersistence as SessionPersistenceSqlite;
}

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
      const after = await rdb(ctx).load(SessionIdBrand("src"));
      expect(after.events).toHaveLength(6);
      expect(after.events.at(-1)?.type).toBe("turn/end");

      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 6,
            time: event.time + 200,
            data: { ...event.data, turn: 2 },
          }) as SessionEvent,
      );
      await rdb(ctx).append(SessionIdBrand("src"), continuation);
      expect(await rdb(ctx).load(SessionIdBrand("src"))).toMatchObject({});
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

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(ctx.sessions.get(SessionIdBrand("live"))).toBe(live);
    } finally {
      await dispose();
    }
  });

  it("stops the running live agent's loop before rewinding", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      ctx.sessions.create(SessionIdBrand("busy"), {
        meta: meta("busy"),
        seed: [...twoTurnLog()],
      });
      const live = ctx.sessions.get(SessionIdBrand("busy"))!;
      await ctx.sessions.flush(live);
      const before = live.snapshotEvents().length;

      const calls: string[] = [];
      const cancels: Array<{ cause: unknown; options: unknown }> = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("busy")
            ? {
                session: live,
                followup: () => {},
                cancel: (cause: unknown, options: unknown) => {
                  calls.push("cancel");
                  cancels.push({ cause, options });
                },
                whenIdle: async () => {
                  calls.push("whenIdle");

                  expect(live.snapshotEvents()).toHaveLength(before);
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

      await editor.rewind(SessionIdBrand("busy"), 5);

      expect(calls).toEqual(["cancel", "whenIdle"]);
      expect(cancels[0]).toEqual({ cause: { kind: "user" }, options: { keepInbox: true } });
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("falls back to waiting when the live agent exposes no cancel capability", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      ctx.sessions.create(SessionIdBrand("legacy"), {
        meta: meta("legacy"),
        seed: [...twoTurnLog()],
      });
      const live = ctx.sessions.get(SessionIdBrand("legacy"))!;
      await ctx.sessions.flush(live);
      const calls: string[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("legacy")
            ? {
                session: live,
                followup: () => {},
                whenIdle: async () => {
                  calls.push("whenIdle");
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

      await editor.rewind(SessionIdBrand("legacy"), 5);

      expect(calls).toEqual(["whenIdle"]);
      expect(live.snapshotEvents()).toHaveLength(6);
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

      let inboxCleared = false;
      const mockAgent: {
        session: typeof live;
        requestHeaderLogged: boolean;
        phase: { lastTurn: number };
        followup: () => void;
        whenIdle: () => Promise<void>;
        inbox: { clear: () => void };
      } = {
        session: live,
        requestHeaderLogged: true,
        phase: { lastTurn: 2 },
        followup: () => {},
        whenIdle: async () => {},
        inbox: {
          clear: () => {
            inboxCleared = true;
          },
        },
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

      const result = await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("live"),
        turn: 2,
        cascade: "truncate",
      });
      expect(result.sessionId).toBe(SessionIdBrand("live"));

      expect(mockAgent.phase.lastTurn).toBe(1);
      expect(mockAgent.requestHeaderLogged).toBe(false);

      expect(inboxCleared).toBe(true);
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
      const child = await rdb(ctx).load(childId);
      expect(child.meta.parentSession).toBe(SessionIdBrand("src"));
      expect(child.events).toHaveLength(12);
    } finally {
      await dispose();
    }
  });
});
