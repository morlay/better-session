import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { describe, expect, it } from "vitest";
import { Context, type Fiber } from "@deepseek-ai/cordis";
import SessionStore, {
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { meta, oneTurnLog, appendLog } from "./contract.ts";

export interface CoordinatorFixture {
  mount: (ctx: Context) => Promise<Fiber>;

  corruptTail?: (id: SessionId, cwd: string | undefined) => Promise<void>;

  cleanup: () => Promise<void>;
}

const WORK = "/w";

function send(session: Session, events: readonly SessionEvent[]): void {
  appendLog(session, events);
}

/**
 * RDB 特有行为契约：live 会话驱动持久化、seed 边界、fork/resume、HMR
 * dispose drain、冲突拒绝、torn-tail。coordinator 内部状态（ownerless /
 * per-id chain / legacy 迁移）已由新版 handle 模型承担，不再单独测试。
 */
export function runCoordinatorContract(
  name: string,
  makeFixture: () => Promise<CoordinatorFixture>,
): void {
  describe(`SessionPersistenceRdb orchestration: ${name}`, () => {
    async function freshCtx(fix: CoordinatorFixture): Promise<{ ctx: Context; fiber: Fiber }> {
      const ctx = new Context();
      await ctx.plugin(SessionStore);
      const fiber = await fix.mount(ctx);
      return { ctx, fiber };
    }

    async function readAll(
      ctx: Context,
      id: SessionId,
    ): Promise<{ meta: Session["header"]; events: readonly SessionEvent[] }> {
      const handle = await ctx.sessionPersistence.open(id, "read");
      try {
        const { events } = await handle.read();
        return { meta: handle.header, events };
      } finally {
        await handle.close();
      }
    }

    it("persists a live session driven through the store, surviving reload", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        const session = ctx.sessions.create(SessionId("live"), { meta: { cwd: WORK } });
        send(session, oneTurnLog());
        await ctx.sessions.flush(session);

        const loaded = await readAll(ctx, SessionId("live"));
        expect(loaded.events).toHaveLength(6);
        expect(loaded.meta.cwd).toBe(WORK);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("round-trips the seed boundary (inheritedEventCount) through persistence", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        let session!: Session;
        const sessionFiber = await ctx.plugin(
          Object.assign(
            (inner: Context) => {
              session = inner.sessions.create(SessionId("forked-child"), {
                seed: oneTurnLog().slice(0, 3),
                meta: { cwd: WORK, isSeeded: true },
                inheritedEventCount: SessionLogOffset(3),
              });
            },
            { inject: ["sessions"] },
          ),
        );
        send(session, oneTurnLog().slice(3));
        await ctx.sessions.flush(session);
        await sessionFiber.dispose();

        const handle = await ctx.sessionPersistence.open(SessionId("forked-child"), "read");
        try {
          expect(handle.header.isSeeded).toBe(true);
          expect(handle.inheritedEventCount).toBe(3);
        } finally {
          await handle.close();
        }
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("round-trips the delegation depth through persistence", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        let session!: Session;
        const sessionFiber = await ctx.plugin(
          Object.assign(
            (inner: Context) => {
              session = inner.sessions.create(SessionId("delegated-child"), {
                meta: { cwd: WORK, parentSession: SessionId("root"), delegationDepth: 2 },
              });
            },
            { inject: ["sessions"] },
          ),
        );
        send(session, oneTurnLog());
        await ctx.parallel("session/flush", session);
        await sessionFiber.dispose();

        const loaded = await readAll(ctx, SessionId("delegated-child"));
        expect(loaded.meta.delegationDepth).toBe(2);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("source-frozen events cannot be mutated after buffering and persist unchanged", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        const session = ctx.sessions.create(SessionId("mutate"), { meta: { cwd: WORK } });
        session.append("turn/start", { turn: 1 });
        const ev = session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text: "original" }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
        expect(() => {
          (ev.data as { content: { type: "text"; text: string }[] }).content[0]!.text = "HACKED";
        }).toThrow(TypeError);
        session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
        await ctx.sessions.flush(session);

        const loaded = await readAll(ctx, SessionId("mutate"));
        const message = loaded.events.find((event) => event.type === "user/message");
        expect(
          message?.type === "user/message" && (message.data.content[0] as { text: string }).text,
        ).toBe("original");
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("fork: a seeded new session persists its seed once (no double-write on a no-op flush)", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        const seed = oneTurnLog();
        // A fork: a brand-new id whose seed came from elsewhere.
        const forked = ctx.sessions.create(SessionId("forked"), { seed, meta: { cwd: WORK } });
        await ctx.sessions.flush(forked); // onCreated persisted the seed
        const loaded = await readAll(ctx, SessionId("forked"));
        // Fork is where the marker earns its keep: the inherited prefix may
        // carry a bracket the still-running parent owns.
        expect(loaded.events.slice(0, seed.length)).toEqual(seed);
        expect(loaded.events.at(-1)).toMatchObject({ type: "session/end-seed", seq: seed.length });
        // A flush with no NEW events must not double-write.
        await ctx.sessions.flush(forked);
        const reloaded = await readAll(ctx, SessionId("forked"));
        expect(reloaded.events).toEqual(loaded.events);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("resume: a re-created session seeded with the loaded log does not re-append its seed and continues the seq", async () => {
      const fix = await makeFixture();
      const first = await freshCtx(fix);
      try {
        const s1 = first.ctx.sessions.create(SessionId("resumed"), { meta: { cwd: WORK } });
        send(s1, oneTurnLog());
        await first.ctx.sessions.flush(s1);
      } finally {
        await first.fiber.dispose();
      }

      const second = await freshCtx(fix);
      try {
        const loaded = await readAll(second.ctx, SessionId("resumed"));
        const s2 = second.ctx.sessions.create(SessionId("resumed"), {
          seed: loaded.events,
          meta: { cwd: WORK },
        });
        await second.ctx.sessions.flush(s2); // let onCreated adopt
        s2.append("turn/start", { turn: 2 });
        s2.append("turn/end", { turn: 2, reason: { kind: "completed" } });
        await second.ctx.sessions.flush(s2);

        const reloaded = await readAll(second.ctx, SessionId("resumed"));
        // 0-5 the resumed seed, 6 end-seed, 7-8 the new turn.
        expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        expect(reloaded.events[6]).toMatchObject({ type: "session/end-seed" });
      } finally {
        await second.fiber.dispose();
        await fix.cleanup();
      }
    });

    it("HMR: applying the plugin seeds existing live sessions", async () => {
      const fix = await makeFixture();
      const ctx = new Context();
      await ctx.plugin(SessionStore);
      // A session exists BEFORE the persistence plugin is applied.
      const session = ctx.sessions.create(SessionId("pre-existing"), { meta: { cwd: WORK } });
      session.append("turn/start", { turn: 1 });
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

      const fiber = await fix.mount(ctx);
      try {
        // The plugin seeded it on apply; a subsequent flush persists its events.
        await ctx.sessions.flush(session);
        const loaded = await readAll(ctx, SessionId("pre-existing"));
        expect(loaded.events.length).toBeGreaterThanOrEqual(2);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("HMR: dispose drains remaining buffers", async () => {
      const fix = await makeFixture();
      const ctx = new Context();
      await ctx.plugin(SessionStore);
      const fiber = await fix.mount(ctx);
      const session = ctx.sessions.create(SessionId("drain"), { meta: { cwd: WORK } });
      session.append("turn/start", { turn: 1 });
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "buffered" }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      // No explicit flush — dispose must drain.
      await fiber.dispose();

      // A fresh backend instance reads what the disposed one drained.
      const second = await freshCtx(fix);
      try {
        const loaded = await readAll(second.ctx, SessionId("drain"));
        expect(loaded.events.length).toBeGreaterThanOrEqual(2);
      } finally {
        await second.fiber.dispose();
        await fix.cleanup();
      }
    });

    it("a NEW live session colliding on a persisted id is rejected, not silently adopted", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        // Persist a session with cwd WORK.
        let first!: Session;
        const firstFiber = await ctx.plugin(
          Object.assign(
            (inner: Context) => {
              first = inner.sessions.create(SessionId("collide"), { meta: { cwd: WORK } });
            },
            { inject: ["sessions"] },
          ),
        );
        send(first, oneTurnLog());
        await ctx.sessions.flush(first);
        await firstFiber.dispose();

        // A NEW live session with the same id but a DIFFERENT cwd must be rejected.
        let second!: Session;
        await ctx.plugin(
          Object.assign(
            (inner: Context) => {
              second = inner.sessions.create(SessionId("collide"), { meta: { cwd: "/other" } });
            },
            { inject: ["sessions"] },
          ),
        );
        await expect(ctx.sessions.flush(second)).rejects.toThrow(/different cwd/);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("an abandoned lazy session (never materialized) releases its id for reuse", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        // A live session created then disposed BEFORE its first append: never
        // materialized. A new live session reusing the id must reclaim it.
        let firstSession!: Session;
        const firstFiber = await ctx.plugin(
          Object.assign(
            (inner: Context) => {
              firstSession = inner.sessions.create(SessionId("abandoned"), { meta: { cwd: WORK } });
            },
            { inject: ["sessions"] },
          ),
        );
        await ctx.sessions.flush(firstSession); // register the lazy state
        await firstFiber.dispose(); // disposed before any append → never materialized

        let reuse!: Session;
        await ctx.plugin(
          Object.assign(
            (inner: Context) => {
              reuse = inner.sessions.create(SessionId("abandoned"), { meta: { cwd: WORK } });
            },
            { inject: ["sessions"] },
          ),
        );
        await expect(ctx.sessions.flush(reuse)).resolves.toBe(true);
        reuse.append("turn/start", { turn: 1 });
        reuse.append("turn/end", { turn: 1, reason: { kind: "completed" } });
        await ctx.sessions.flush(reuse);
        const loaded = await readAll(ctx, SessionId("abandoned"));
        expect(loaded.events.map((e) => e.seq)).toEqual([0, 1]);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("append adopts a storage-only session (fresh instance) and continues the seq", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        const m = meta("storage-only", WORK);
        const handle = await ctx.sessionPersistence.create(m);
        await handle.append(oneTurnLog());
        await handle.close();

        // A fresh backend instance appends through a write handle.
        const writer = await ctx.sessionPersistence.open(SessionId("storage-only"), "write");
        await writer.append([
          { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
          {
            type: "turn/end",
            seq: SessionSeq(7),
            time: 8,
            data: { turn: 2, reason: { kind: "completed" } },
          },
        ]);
        await writer.close();

        const loaded = await readAll(ctx, SessionId("storage-only"));
        expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("create rejects a duplicate id (in memory and on a persisted log)", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        const m = meta("dup-id", WORK);
        const first = await ctx.sessionPersistence.create(m);
        await expect(ctx.sessionPersistence.create(m)).rejects.toThrow(/already exists/);
        await first.append(oneTurnLog());
        await first.close();
        await expect(ctx.sessionPersistence.create(m)).rejects.toThrow(/already exists/);
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("round-trips a header with parentSession (fork lineage)", async () => {
      const fix = await makeFixture();
      const { ctx, fiber } = await freshCtx(fix);
      try {
        const m = meta("lineage", WORK);
        const handle = await ctx.sessionPersistence.create({
          ...m,
          parentSession: SessionId("parent"),
        });
        await handle.append(oneTurnLog());
        await handle.close();

        const loaded = await readAll(ctx, SessionId("lineage"));
        expect(loaded.meta.parentSession).toBe(SessionId("parent"));
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });

    it("torn-tail: a never-committed tail is truncated by the write path", async () => {
      const fix = await makeFixture();
      if (fix.corruptTail === undefined) return;
      const { ctx, fiber } = await freshCtx(fix);
      try {
        const m = meta("torn", WORK);
        const creator = await ctx.sessionPersistence.create(m);
        await creator.append(oneTurnLog());
        await creator.close();
        await fix.corruptTail(SessionId("torn"), WORK);

        // A reader serves only the committed prefix.
        const reader = await ctx.sessionPersistence.open(SessionId("torn"), "read");
        expect((await reader.read()).events).toEqual(oneTurnLog());
        await reader.close();

        // A write open + first append durably truncates the torn tail.
        const writer = await ctx.sessionPersistence.open(SessionId("torn"), "write");
        await writer.append([
          { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
          {
            type: "turn/end",
            seq: SessionSeq(7),
            time: 8,
            data: { turn: 2, reason: { kind: "completed" } },
          },
        ]);
        expect((await writer.read()).events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        await writer.close();
      } finally {
        await fiber.dispose();
        await fix.cleanup();
      }
    });
  });
}
