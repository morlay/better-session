import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import {
  Session,
  SessionId,
  SessionSeq,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
  type SurfaceEvent,
} from "@deepseek-ai/dsh-session";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { SessionBranchError } from "@morlay/session-branch";
import SessionPersistenceSqlite, {
  SessionBranchRdbProvider,
  locateTurnEnd,
} from "@morlay/session-rdb";
import { EmptySettings } from "@morlay/session-rdb/testing";
import { appendLog, meta, oneTurnLog } from "@morlay/session-rdb/testing";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function harness(): Promise<{
  ctx: Context;
  persistence: SessionPersistenceSqlite;
  provider: SessionBranchRdbProvider;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  const persistence = ctx.sessionPersistence as SessionPersistenceSqlite;
  const provider = new SessionBranchRdbProvider(persistence, {
    getSession: (id) => ctx.sessions.get(id),
    getAgent: () => undefined,
    flush: (session) => ctx.sessions.flush(session),
  });
  return { ctx, persistence, provider, dispose: () => fiber.dispose() };
}

// ctx.logger 的默认 exporter 阈值是 INFO（warn 不进内置 buffer），这里挂一个收集 warn 的 exporter
function captureWarnings(ctx: Context): () => string[] {
  const messages: string[] = [];
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      if (message.type === "warn") messages.push(String(message.args[0]));
    },
  });
  return () => messages;
}

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
  const handle = await ctx.sessionPersistence.create(header);
  try {
    await handle.append([...events]);
  } finally {
    await handle.close();
  }
}

describe("locateTurnEnd", () => {
  it("returns the last closed turn end without an anchor", () => {
    expect(locateTurnEnd(twoTurnLog())).toBe(11);
  });

  it("after mode: anchors to the first turn/end at or past the anchor", () => {
    const log = twoTurnLog();
    expect(locateTurnEnd(log, 1, "after")).toBe(5);
    expect(locateTurnEnd(log, 6, "after")).toBe(11);
  });

  it("before mode: anchors to the last turn/end before the anchor", () => {
    const log = twoTurnLog();
    expect(locateTurnEnd(log, 6, "before")).toBe(5);
    expect(locateTurnEnd(log, 0, "before")).toBe(-1);
  });

  it("rejects an anchor inside an open turn (after mode)", () => {
    const log: SessionEvent[] = [
      ...twoTurnLog(),
      { type: "turn/start", seq: SessionSeq(12), time: 1, data: { turn: 3 } },
    ];
    expect(() => locateTurnEnd(log, 13, "after")).toThrow(SessionBranchError);
  });

  it("rejects a session with no closed turn", () => {
    expect(() => locateTurnEnd([], undefined, "after")).toThrow(/no closed turn/);
  });
});

describe("readBranchPrefix", () => {
  it("returns the closed prefix anchored after the given seq", async () => {
    const { ctx, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const boundary = await provider.readBranchPrefix(SessionId("s1"), 1, "after");
      expect(boundary.seq).toBe(5);
      expect(boundary.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      await dispose();
    }
  });

  it("returns the prefix before the given seq (exclusive mode)", async () => {
    const { ctx, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const boundary = await provider.readBranchPrefix(SessionId("s1"), 6, "before");
      expect(boundary.seq).toBe(5);
      expect(boundary.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      await dispose();
    }
  });

  it("rejects an unknown session", async () => {
    const { provider, dispose } = await harness();
    try {
      await expect(provider.readBranchPrefix(SessionId("missing"))).rejects.toThrow();
    } finally {
      await dispose();
    }
  });
});

describe("forkFrom", () => {
  it("derives a child session with parent lineage and renumbered seed", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      const childId = await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
        meta: { cwd: "/work" },
      });
      expect(childId).toBe("child");
      const child = await persistence.load(childId);
      expect(child.meta.parentSession).toBe(SessionId("src"));
      expect(child.meta.isSeeded).toBe(true);
      expect(child.inheritedEventCount).toBe(6);
      expect(child.meta.cwd).toBe("/work");
      expect(child.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(child.events[0]?.type).toBe("turn/start");
      expect(child.events[5]?.type).toBe("turn/end");

      const source = await persistence.load(SessionId("src"));
      expect(source.events).toHaveLength(12);
    } finally {
      await dispose();
    }
  });

  it("drops ignorable version events from the canonical log (ignorable semantics)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      const version = {
        type: "session-branch/version",
        seq: SessionSeq(0),
        time: 1,
        ignorable: true,
        data: {
          schemaVersion: 1,
          effect: {
            id: "e1",
            operation: "retry",
            cascade: "truncate",
            targetTurn: 2,
            targetEventSeq: 6,
          },
          inverse: { kind: "restore-version", sessionId: SessionId("src") },
        },
      } as unknown as SessionEvent;
      await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
        seedSuffix: [version],
      });
      const child = await persistence.load(SessionId("child"));

      expect(child.events).toHaveLength(7);
      expect(child.events.some((e) => (e.type as string) === "session-branch/version")).toBe(true);
      expect(child.meta.isSeeded).toBe(true);
      expect(child.inheritedEventCount).toBe(6);
    } finally {
      await dispose();
    }
  });

  it("reuses parent event rows (no event-row copy; bridge rows only)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      const backend = persistence.internals().backend as unknown as {
        getEventRows(id: SessionId): Promise<Array<{ fEventId: string; fSequence: number }>>;
      };
      const parentRows = await backend.getEventRows(SessionId("src"));
      expect(parentRows).toHaveLength(12);

      await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
      });

      const childRows = await backend.getEventRows(SessionId("child"));
      expect(childRows).toHaveLength(6);
      expect(childRows.map((r) => r.fEventId)).toEqual(
        parentRows.slice(0, 6).map((r) => r.fEventId),
      );

      const childBridges = await backend.getEventRows(SessionId("child"));
      expect(childBridges.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      await dispose();
    }
  });
});

describe("rewind", () => {
  it("truncates to a closed turn/end boundary and bumps revision", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const before = await persistence.listSnapshots();
      const revBefore = before.find((s) => s.header.id === "s1")?.revision;

      const snapshot = await provider.rewind(SessionId("s1"), 5);
      expect(snapshot.header.id).toBe("s1");

      const after = await persistence.load(SessionId("s1"));
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(after.events.at(-1)?.type).toBe("turn/end");

      const afterSnapshots = await persistence.listSnapshots();
      const revAfter = afterSnapshots.find((s) => s.header.id === "s1")?.revision;
      expect(revAfter).not.toBe(revBefore);
    } finally {
      await dispose();
    }
  });

  it("rejects a non-turn/end boundary", async () => {
    const { ctx, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      await expect(provider.rewind(SessionId("s1"), 4)).rejects.toThrow(/not a turn\/end/);
    } finally {
      await dispose();
    }
  });

  it("rejects a boundary beyond the stored head", async () => {
    const { ctx, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      await expect(provider.rewind(SessionId("s1"), 99)).rejects.toThrow(SessionBranchError);
    } finally {
      await dispose();
    }
  });

  it("invalidates live projection cells on rewind so replayed events fold again", async () => {
    const { ctx, dispose } = await harness();
    try {
      const projections = ctx.sessionProjections as unknown as {
        register(definition: unknown): () => void;
        stateOf(session: Session, key: never): unknown;
      };
      projections.register({
        key: "test/count",
        stateSchema: {},
        init: () => 0,
        apply: (state: number) => state + 1,
        stateVersion: 0,
      });

      ctx.sessions.create(SessionId("proj"), { meta: meta("proj"), seed: [...twoTurnLog()] });
      const live = ctx.sessions.get(SessionId("proj"))!;
      await ctx.sessions.flush(live);

      expect(projections.stateOf(live, "test/count" as never)).toBe(13);

      await ctx.sessionBranch.rewind(SessionId("proj"), 5);
      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      liveAppend.append("turn/start", { turn: 3 });

      expect(projections.stateOf(live, "test/count" as never)).toBe(7);
    } finally {
      await dispose();
    }
  });

  it("rewind flushes the durable inbox cancellation of the live agent", async () => {
    const { ctx, persistence, dispose } = await harness();
    try {
      ctx.sessions.create(SessionId("pending"), {
        meta: meta("pending"),
        seed: [...twoTurnLog()],
      });
      const live = ctx.sessions.get(SessionId("pending"))!;
      await ctx.sessions.flush(live);

      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionId) =>
          id === SessionId("pending")
            ? {
                session: live,
                inbox: {
                  clear: () => {
                    liveAppend.append("agent/inbox/spliced", {
                      target: "next-turn",
                      start: 0,
                      removedCount: 1,
                      inserted: [],
                      outcome: "canceled",
                    });
                  },
                },
              }
            : undefined,
      });

      await ctx.sessionBranch.rewind(SessionId("pending"), 5);

      const backend = persistence.internals().backend as unknown as {
        getHead(id: SessionId): Promise<{ fHeadSequence: number }>;
      };
      const head = await backend.getHead(SessionId("pending"));
      expect(head.fHeadSequence).toBe(6);
      expect(live.snapshotEvents().at(-1)?.type).toBe("agent/inbox/spliced");
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("rewinds a live session in place (memory log, RDB head, and coordinator resynced)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      const events = twoTurnLog();
      ctx.sessions.create(SessionId("live"), { meta: meta("live"), seed: [...events] });
      const live = ctx.sessions.get(SessionId("live"))!;
      await ctx.sessions.flush(live);

      expect(live.snapshotEvents()).toHaveLength(13);

      const snapshot = await provider.rewind(SessionId("live"), 5);
      expect(snapshot.header.id).toBe("live");

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);

      const backend = persistence.internals().backend as unknown as {
        getHead(id: SessionId): Promise<{ fHeadSequence: number }>;
      };
      const head = await backend.getHead(SessionId("live"));
      expect(head.fHeadSequence).toBe(5);

      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      liveAppend.append("turn/start", { turn: 3 });
      await ctx.sessions.flush(live);
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);

      expect(live.deriveMessages().map((m) => m.content[0])).toEqual([
        expect.objectContaining({ type: "text", text: "hi" }),
        expect.objectContaining({ type: "text", text: "hello" }),
      ]);
    } finally {
      await dispose();
    }
  });

  it("allows appending after rewind (coordinator state resynchronized)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      await provider.rewind(SessionId("s1"), 5);

      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 6,
            time: event.time + 200,
            data: { ...event.data, turn: 2 },
          }) as SessionEvent,
      );
      await persistence.append(SessionId("s1"), continuation);
      const after = await persistence.load(SessionId("s1"));
      expect(after.events).toHaveLength(12);
      expect(after.events[5]?.type).toBe("turn/end");
      expect(after.events[11]?.type).toBe("turn/end");
    } finally {
      await dispose();
    }
  });

  it("rewinds to the empty prefix when boundary is -1", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const snapshot = await provider.rewind(SessionId("s1"), -1);
      expect(snapshot.header.id).toBe("s1");
      const after = await persistence.load(SessionId("s1"));
      expect(after.events).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it("shrinks the inherited prefix length when rewind cuts into the seed", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
      });

      const before = await persistence.load(SessionId("child"));
      expect(before.inheritedEventCount).toBe(6);
      expect(before.events).toHaveLength(6);

      const snapshot = await provider.rewind(SessionId("child"), 1);
      expect(snapshot.header.id).toBe("child");

      const stored = await persistence.readLog(SessionId("child"));
      expect(stored).toBeDefined();
      expect(stored!.events).toHaveLength(1);
      expect(stored!.events[0]?.type).toBe("turn/start");
      expect(stored!.inheritedEventCount).toBe(1);

      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 1,
            time: event.time + 200,
            data: { ...event.data, turn: 2 },
          }) as SessionEvent,
      );
      await persistence.append(SessionId("child"), continuation);
      const continued = await persistence.load(SessionId("child"));
      expect(continued.events).toHaveLength(7);
      expect(continued.inheritedEventCount).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("rewinds to a user/message boundary (exclusive: drops the message and its tail)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
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
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
      ];
      await createPersisted(ctx, "s1", [...twoTurnLog(), ...openTail]);

      const snapshot = await provider.rewind(SessionId("s1"), 13);
      expect(snapshot.header.id).toBe("s1");

      const continuation: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 13,
            time: event.time + 300,
            data: { ...event.data, turn: 3 },
          }) as SessionEvent,
      );
      await persistence.append(SessionId("s1"), continuation);
      const after = await persistence.load(SessionId("s1"));

      expect(after.events.map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
      ]);
      expect(after.events[12]?.type).toBe("turn/start");
      expect(after.events[13]?.type).toBe("turn/start");
      expect(after.events[14]?.type).toBe("user/message");
      expect(after.events.at(-1)?.type).toBe("turn/end");

      expect(
        after.events.some((e) => e.type === "user/message" && e.data.id === "turn3-user"),
      ).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("rejects a boundary that is neither turn/end nor user/message", async () => {
    const { ctx, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());

      await expect(provider.rewind(SessionId("s1"), 4)).rejects.toThrow(
        /not a turn\/end or user\/message/,
      );
    } finally {
      await dispose();
    }
  });

  it("rewinds to a user/message boundary in real agent-loop order (orphan step/start dropped)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
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
          } as unknown as SessionEvent,
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
      await createPersisted(ctx, "s1", [...twoTurnLog(), ...openTail]);

      await provider.rewind(SessionId("s1"), 14);

      const backend = (
        persistence as unknown as {
          internals(): {
            backend: {
              getEventRows(id: SessionId): Promise<Array<{ fSequence: number; fType: string }>>;
            };
          };
        }
      ).internals().backend;
      const rows = await backend.getEventRows(SessionId("s1"));
      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(rows.at(-1)?.fType).toBe("turn/start");
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
      await persistence.append(SessionId("s1"), continuation);
      const continued = await persistence.load(SessionId("s1"));
      expect(continued.events.at(-1)?.type).toBe("turn/end");
      const meter = new TokenMeter(ctx);
      const replayed = Session.create(SessionId("s1"), [...continued.events]);
      expect(() => meter.measure(replayed)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("loads a rewind-to-user-message session without an orphan step/start (token-meter replay safe)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
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
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(16), time: 16, data: { turn: 3, step: 1 } },
      ];
      await createPersisted(ctx, "s1", [...twoTurnLog(), ...openTail]);
      await provider.rewind(SessionId("s1"), 14);

      const after = await persistence.load(SessionId("s1"));
      expect(after.events.some((e) => e.type === "step/start" && e.data.turn === 3)).toBe(false);
      const meter = new TokenMeter(ctx);
      const session = Session.create(SessionId("s1"), [...after.events]);
      expect(() => meter.measure(session)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("rewind keeps a surviving replace loadable (range intact, provenance recomputed)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      const compacted = [
        ...twoTurnLog().slice(0, 6),
        { type: "turn/start", seq: SessionSeq(6), time: 6, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(7), time: 7, data: { turn: 2, step: 1 } },
        {
          type: "compaction/summary",
          seq: SessionSeq(8),
          time: 8,
          data: {
            turn: 2,
            summary: "compacted",
            shadowedRange: { start: 1, end: 3 },
            shadowedTokenCount: 100,
          },
        },
        {
          type: "user/message",
          seq: SessionSeq(9),
          time: 9,
          data: {
            id: "compacted",
            role: "user",
            content: [{ type: "text", text: "compacted" }],
            source: { kind: "user" },
          },
          surfaceOp: { op: "replace", startSeq: 1, endSeq: 3 },
          sourceEventSeqs: [1, 3].map((n) => SessionSeq(n)),
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(10), time: 10, data: { turn: 2, step: 1 } },
        {
          type: "turn/end",
          seq: SessionSeq(11),
          time: 11,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ] as unknown as SessionEvent[];
      await createPersisted(ctx, "s1", compacted);

      await provider.rewind(SessionId("s1"), 5);
      const after = await persistence.load(SessionId("s1"));
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(after.events.at(-1)?.type).toBe("turn/end");

      const meter = new TokenMeter(ctx);
      const session = Session.create(SessionId("s1"), [...after.events]);
      expect(() => meter.measure(session)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("rewind to a boundary before a surviving replace keeps the replace loadable", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      const compacted = [
        ...twoTurnLog().slice(0, 6),
        { type: "turn/start", seq: SessionSeq(6), time: 6, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(7), time: 7, data: { turn: 2, step: 1 } },
        {
          type: "compaction/summary",
          seq: SessionSeq(8),
          time: 8,
          data: {
            turn: 2,
            summary: "compacted",
            shadowedRange: { start: 1, end: 3 },
            shadowedTokenCount: 100,
          },
        },
        {
          type: "user/message",
          seq: SessionSeq(9),
          time: 9,
          data: {
            id: "compacted",
            role: "user",
            content: [{ type: "text", text: "compacted" }],
            source: { kind: "user" },
          },
          surfaceOp: { op: "replace", startSeq: 1, endSeq: 3 },
          sourceEventSeqs: [1, 3].map((n) => SessionSeq(n)),
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(10), time: 10, data: { turn: 2, step: 1 } },
        {
          type: "turn/end",
          seq: SessionSeq(11),
          time: 11,
          data: { turn: 2, reason: { kind: "completed" } },
        },
        ...twoTurnLog()
          .slice(6)
          .map((e) => ({ ...e, seq: e.seq + 6, time: e.time + 100 })),
      ] as unknown as SessionEvent[];
      await createPersisted(ctx, "s1", compacted);

      await provider.rewind(SessionId("s1"), 11);
      const after = await persistence.load(SessionId("s1"));
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

      const replacement = after.events.find((e) => e.type === "user/message" && e.seq === 9)!;
      expect((replacement as SurfaceEvent).surfaceOp).toEqual({
        op: "replace",
        startSeq: 1,
        endSeq: 3,
      });

      expect((replacement as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);
      const meter = new TokenMeter(ctx);
      const session = Session.create(SessionId("s1"), [...after.events]);
      expect(() => meter.measure(session)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("rewinds to a mid-turn followup of a CLOSED turn, then agent-style continuation keeps the session loadable", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      const turn2: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(8),
          time: 9,
          data: {
            id: "t2-u1",
            role: "user",
            content: [{ type: "text", text: "q1" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        {
          type: "assistant/message",
          seq: SessionSeq(9),
          time: 10,
          data: {
            turn: 2,
            step: 1,
            message: {
              id: "t2-a1",
              role: "assistant",
              content: [{ type: "text", text: "a1" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(10), time: 11, data: { turn: 2, step: 1 } },
        { type: "step/start", seq: SessionSeq(11), time: 12, data: { turn: 2, step: 2 } },
        {
          type: "user/message",
          seq: SessionSeq(12),
          time: 13,
          data: {
            id: "t2-fup",
            role: "user",
            content: [{ type: "text", text: "followup" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(13), time: 14, data: { turn: 2, step: 2 } },
        {
          type: "turn/end",
          seq: SessionSeq(14),
          time: 15,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await createPersisted(ctx, "s1", [...oneTurnLog(), ...turn2]);

      await provider.rewind(SessionId("s1"), 12);

      const backend = (
        persistence as unknown as {
          internals(): {
            backend: {
              getEventRows(id: SessionId): Promise<Array<{ fSequence: number; fType: string }>>;
            };
          };
        }
      ).internals().backend;
      const rows = await backend.getEventRows(SessionId("s1"));

      expect(rows.map((r) => r.fSequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(rows.some((r) => r.fType === "step/start" && r.fSequence === 11)).toBe(false);

      const continuation: SessionEvent[] = [
        { type: "step/start", seq: SessionSeq(11), time: 16, data: { turn: 2, step: 3 } },
        {
          type: "user/message",
          seq: SessionSeq(12),
          time: 17,
          data: {
            id: "t2-fup-edited",
            role: "user",
            content: [{ type: "text", text: "followup edited" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        {
          type: "assistant/message",
          seq: SessionSeq(13),
          time: 18,
          data: {
            turn: 2,
            step: 3,
            message: {
              id: "t2-a2",
              role: "assistant",
              content: [{ type: "text", text: "a2" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
            stream: [],
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
        { type: "step/end", seq: SessionSeq(14), time: 19, data: { turn: 2, step: 3 } },
        {
          type: "turn/end",
          seq: SessionSeq(15),
          time: 20,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await persistence.append(SessionId("s1"), continuation);

      const after = await persistence.load(SessionId("s1"));
      expect(after.events.at(-1)?.type).toBe("turn/end");
      const meter = new TokenMeter(ctx);
      const session = Session.create(SessionId("s1"), [...after.events]);
      expect(() => meter.measure(session)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("invalidates the token meter fold so a rewound live session stays measurable", async () => {
    const { ctx, dispose } = await harness();
    try {
      const meter = new TokenMeter(ctx);

      const log = [
        ...oneTurnLog(),
        ...oneTurnLog().map(
          (event) =>
            ({
              ...event,
              seq: event.seq + 6,
              time: event.time + 100,
              data: { ...event.data, turn: 2 },
            }) as SessionEvent,
        ),
        ...oneTurnLog().map(
          (event) =>
            ({
              ...event,
              seq: event.seq + 12,
              time: event.time + 200,
              data: { ...event.data, turn: 3 },
            }) as SessionEvent,
        ),
      ];
      ctx.sessions.create(SessionId("s1"), { meta: meta("s1"), seed: log });
      const live = ctx.sessions.get(SessionId("s1"))!;
      await ctx.sessions.flush(live);
      meter.measure(live);

      const inner = meter as unknown as { states: WeakMap<object, { consumedEvents: number }> };
      const foldedWatermark = inner.states.get(live)!.consumedEvents;

      await ctx.sessionBranch.rewind(SessionId("s1"), 11);
      expect(live.snapshotEvents().map((event) => event.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);

      const continuation: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(12), time: 500, data: { turn: 4 } } as SessionEvent,
        {
          type: "step/start",
          seq: SessionSeq(13),
          time: 501,
          data: { turn: 4, step: 1 },
        } as SessionEvent,
      ];
      for (let seq = 14; seq < foldedWatermark; seq += 1) {
        continuation.push({
          type: "user/message",
          seq: SessionSeq(seq),
          time: 600 + seq,
          data: {
            id: `rewound-fill-${seq}`,
            role: "user",
            content: [{ type: "text", text: `fill ${seq}` }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent);
      }
      continuation.push(
        {
          type: "step/end",
          seq: SessionSeq(foldedWatermark),
          time: 700,
          data: { turn: 4, step: 1 },
        } as SessionEvent,
        {
          type: "turn/end",
          seq: SessionSeq(foldedWatermark + 1),
          time: 701,
          data: { turn: 4, reason: { kind: "completed" } },
        } as SessionEvent,
      );
      appendLog(live, continuation);
      await ctx.sessions.flush(live);

      expect(() => meter.measure(live)).not.toThrow();

      expect(inner.states.get(live)?.consumedEvents).toBe(live.snapshotEvents().length);
    } finally {
      await dispose();
    }
  });
});

// 破损形状：turn 2 的 step/start 已丢失，只在日志里留下 step/end（历史遗留 / 导入带来的残尾）
function orphanStepEndLog(): SessionEvent[] {
  return [
    ...oneTurnLog(),
    { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
    { type: "step/end", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
    {
      type: "turn/end",
      seq: SessionSeq(8),
      time: 9,
      data: { turn: 2, reason: { kind: "completed" } },
    },
  ];
}

describe("rewind step balance self-heal", () => {
  it("balances only the tail window (an inner orphan step/end stays; the log is not read in full)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", orphanStepEndLog());

      const backend = (persistence.internals() as unknown as { backend: Record<string, unknown> })
        .backend;
      const reads: string[] = [];
      for (const name of ["getEventRows", "getEventTypesBefore"]) {
        const original = (backend[name] as (...args: unknown[]) => Promise<unknown>).bind(backend);
        backend[name] = async (...args: unknown[]) => {
          reads.push(name);
          return original(...args);
        };
      }

      await provider.rewind(SessionId("s1"), 8);

      // 内部孤儿（seq 7 的 step/end）不在尾部窗口内：rewind 不改写它，破损由整段日志的路径（导出/导入）自愈
      expect([...reads]).not.toContain("getEventRows");
      expect([...reads]).toContain("getEventTypesBefore");

      const after = await persistence.load(SessionId("s1"));
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect(after.events.some((e) => e.type === "step/end" && e.data.turn === 2)).toBe(true);

      // 尾部窗口（turn/end 边界 + 之后没有孤儿）不动保留前缀
      await provider.rewind(SessionId("s1"), 5);
      expect((await persistence.load(SessionId("s1"))).events.map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5,
      ]);
    } finally {
      await dispose();
    }
  });

  it("live rewind follows the same tail-window rule (no full log read)", async () => {
    const { ctx, persistence, dispose } = await harness();
    try {
      await createPersisted(ctx, "s1", orphanStepEndLog());
      ctx.sessions.create(SessionId("s1"), { meta: meta("s1"), seed: [...orphanStepEndLog()] });
      const live = ctx.sessions.get(SessionId("s1"))!;
      await ctx.sessions.flush(live);

      const backend = (persistence.internals() as unknown as { backend: Record<string, unknown> })
        .backend;
      const reads: string[] = [];
      for (const name of ["getEventRows", "getEventTypesBefore"]) {
        const original = (backend[name] as (...args: unknown[]) => Promise<unknown>).bind(backend);
        backend[name] = async (...args: unknown[]) => {
          reads.push(name);
          return original(...args);
        };
      }

      await ctx.sessionBranch.rewind(SessionId("s1"), 8);

      expect([...reads]).not.toContain("getEventRows");
      expect([...reads]).toContain("getEventTypesBefore");

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const after = await persistence.load(SessionId("s1"));
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      await dispose();
    }
  });

  it("drops the tail from an orphan step/end in a forked seed", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", orphanStepEndLog());

      const childId = await provider.forkFrom(SessionId("src"), {
        atSeq: 8,
        childSessionId: SessionId("child"),
      });

      const child = await persistence.load(childId);
      expect(child.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(child.inheritedEventCount).toBe(7);
      const session = Session.create(childId, [...child.events]);
      expect(() => new TokenMeter(ctx).measure(session)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it("keeps a forked seed whose steps are already paired untouched", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());

      const childId = await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
      });

      const child = await persistence.load(childId);
      expect(child.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(child.inheritedEventCount).toBe(6);
      const session = Session.create(childId, [...child.events]);
      expect(() => new TokenMeter(ctx).measure(session)).not.toThrow();
    } finally {
      await dispose();
    }
  });
});

describe("rewind derived-state invalidation", () => {
  it("warns once per plugin instance when the token meter service is missing", async () => {
    const { ctx, dispose } = await harness();
    try {
      const warnings = captureWarnings(ctx);

      ctx.sessions.create(SessionId("s1"), { meta: meta("s1"), seed: [...twoTurnLog()] });
      const live = ctx.sessions.get(SessionId("s1"))!;
      await ctx.sessions.flush(live);

      await ctx.sessionBranch.rewind(SessionId("s1"), 5);
      await ctx.sessionBranch.rewind(SessionId("s1"), 1);
      await ctx.sessionBranch.rewind(SessionId("s1"), -1);

      expect(warnings().filter((message) => message.includes("tokenMeter"))).toHaveLength(1);
      expect(warnings().join("\n")).toContain("token-meter");
      expect(warnings().join("\n")).toContain("step/end");
    } finally {
      await dispose();
    }
  });

  it("warns once when the token meter and projection registry shapes change", async () => {
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const provide = (name: string, value: unknown): (() => void) => ctx.provide(name, value);
    provide("sessionProjections", { registrations: null });
    provide("tokenMeter", { states: new Map() });
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path: ":memory:",
    });
    try {
      const warnings = captureWarnings(ctx);

      ctx.sessions.create(SessionId("s1"), { meta: meta("s1"), seed: [...twoTurnLog()] });
      const live = ctx.sessions.get(SessionId("s1"))!;
      await ctx.sessions.flush(live);

      await ctx.sessionBranch.rewind(SessionId("s1"), 5);
      await ctx.sessionBranch.rewind(SessionId("s1"), 1);

      expect(warnings().filter((message) => message.includes("tokenMeter.states"))).toHaveLength(1);
      expect(
        warnings().filter((message) => message.includes("registrations is not a Map")),
      ).toHaveLength(1);
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0]);
    } finally {
      await fiber.dispose();
    }
  });
});
