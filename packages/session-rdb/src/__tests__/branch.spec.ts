/**
 * RDB 分支 provider（rewind / forkFrom / readBranchPrefix）的端到端测试：
 * 在真实 SQLite 后端上验证闭合边界定位、派生（纯 append）与截断式回退
 * （含 coordinator 状态同步）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { SessionBranchError } from "@morlay/session-branch";
import SessionPersistenceSqlite, { SessionBranchRdbProvider, locateTurnEnd } from "../index.ts";
import { EmptySettings } from "./testing/helpers.ts";
import { meta, oneTurnLog } from "./testing/contract.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A context with session store + SQLite backend + branch provider. */
async function harness(): Promise<{
  ctx: Context;
  persistence: SessionPersistenceSqlite;
  provider: SessionBranchRdbProvider;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  const persistence = ctx.sessionPersistence as SessionPersistenceSqlite;
  const provider = new SessionBranchRdbProvider(persistence, {
    getSession: (id) => ctx.sessions.get(id),
    getAgent: () => undefined,
    flush: (session) => ctx.sessions.flush(session),
    setCoordinatorCursor: (id, cursor) => {
      const withCoordinator = persistence as unknown as {
        coordinator?: {
          states?: Map<SessionId, { cursor: number } | undefined>;
        };
      };
      const state = withCoordinator.coordinator?.states?.get(id);
      if (state !== undefined) state.cursor = cursor;
    },
  });
  return { ctx, persistence, provider, dispose: () => fiber.dispose() };
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

/** 创建并落盘一个会话（走持久化 API，会话保持 cold / ownerless）。 */
async function createPersisted(
  ctx: Context,
  id: string,
  events: readonly SessionEvent[],
  header: SessionHeader = meta(id),
): Promise<void> {
  await ctx.sessionPersistence.create(header);
  await ctx.sessionPersistence.append(SessionId(id), [...events]);
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
      { type: "turn/start", seq: 12, time: 1, data: { turn: 3 } },
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
      expect(child.meta.seedLength).toBe(6);
      expect(child.meta.cwd).toBe("/work");
      expect(child.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(child.events[0]?.type).toBe("turn/start");
      expect(child.events[5]?.type).toBe("turn/end");
      // 源会话不变
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
        seq: 0,
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
      } as SessionEvent;
      await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
        seedSuffix: [version],
      });
      const child = await persistence.load(SessionId("child"));
      // ignorable 事件不进 canonical log：只有边界前缀（6 事件）。
      expect(child.events).toHaveLength(6);
      expect(child.events.some((e) => (e.type as string) === "session-branch/version")).toBe(false);
      expect(child.meta.seedLength).toBe(6);
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

  it("rewinds a live session in place (memory log, RDB head, and coordinator resynced)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      // live 会话：create 时 seed 直接落盘（coordinator onCreated case 4）。
      const events = twoTurnLog();
      ctx.sessions.create(SessionId("live"), { meta: meta("live"), seed: [...events] });
      const live = ctx.sessions.get(SessionId("live"))!;
      await ctx.sessions.flush(live);
      // 12 seed 事件 + 构造时自动补记的 session/end-seed（seq 12）。
      expect(live.events).toHaveLength(13);

      const snapshot = await provider.rewind(SessionId("live"), 5);
      expect(snapshot.header.id).toBe("live");

      // live 内存 log 截断到边界（含派生缓存与 surface 状态复位）。
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      // RDB head 截断（load/inspect 在 live 时读内存，直接校验后端 head）。
      const backend = persistence.internals().backend as unknown as {
        getHead(id: SessionId): Promise<{ fHeadSequence: number }>;
      };
      const head = await backend.getHead(SessionId("live"));
      expect(head.fHeadSequence).toBe(5);

      // coordinator 内存状态已同步：截断后继续 append（seq 6 续接）成功——
      // 说明 cursor 已对齐新尾部，没有残留的旧 cursor。
      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      liveAppend.append("turn/start", { turn: 3 });
      await ctx.sessions.flush(live);
      expect(live.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);

      // surface 派生缓存重建：仍能派生截断前缀的完整消息历史。
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

      // 通过 coordinator 标准路径续写（rewind 后 state.cursor 已同步为 6）。
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
});
