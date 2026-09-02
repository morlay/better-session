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
import SessionPersistenceSqlite, { SessionBranchRdbProvider, locateTurnEnd } from "../index.ts";
import { EmptySettings } from "./testing/helpers.ts";
import { meta, oneTurnLog } from "./testing/contract.ts";

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
    setCoordinatorCursor: (id, cursor) => {
      const withCoordinator = persistence as unknown as {
        coordinator?: {
          states?: Map<SessionId, { cursor: number } | undefined>;
        };
      };
      const state = withCoordinator.coordinator?.states?.get(id);
      if (state !== undefined) state.cursor = cursor;
    },
    setCoordinatorState: (id, cursor, meta) => {
      const withCoordinator = persistence as unknown as {
        coordinator?: {
          states?: Map<
            SessionId,
            { cursor: number; meta: SessionHeader; materialized: boolean } | undefined
          >;
        };
      };
      const states = withCoordinator.coordinator?.states;
      if (states === undefined) return;
      const state = states.get(id);
      if (state !== undefined) {
        state.cursor = cursor;
      } else {
        states.set(id, { meta, cursor, materialized: true });
      }
    },
    setCoordinatorSeedLength: (id, seedLength) => {
      const withCoordinator = persistence as unknown as {
        coordinator?: {
          states?: Map<
            SessionId,
            | {
                storage?: { inheritedEventCount: number };
              }
            | undefined
          >;
        };
      };
      const state = withCoordinator.coordinator?.states?.get(id);
      if (state?.storage !== undefined && state.storage.inheritedEventCount > seedLength) {
        // storage 对象可能被冻结（coordinator 发布路径）；整体替换而非改字段。
        state.storage = { ...state.storage, inheritedEventCount: seedLength };
      }
    },
  });
  return { ctx, persistence, provider, dispose: () => fiber.dispose() };
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
        // `ignorable` 是下游信封扩展（上游 SessionEvent 无此字段），
        // 结构化构造版本效果事件信封。
      } as unknown as SessionEvent;
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
        getSeqMapRows(id: SessionId): Promise<Array<{ fOriginalSeq: number }>>;
      };
      const parentRows = await backend.getEventRows(SessionId("src"));
      expect(parentRows).toHaveLength(12);

      await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
      });

      // 事件行复用是存储层事实：子会话桥接行引用父会话前 6 个事件行
      // （f_event_id 复用，不复制事件行）。
      const childRows = await backend.getEventRows(SessionId("child"));
      expect(childRows).toHaveLength(6);
      expect(childRows.map((r) => r.fEventId)).toEqual(
        parentRows.slice(0, 6).map((r) => r.fEventId),
      );
      // 子会话桥接行的 f_original_seq 是子会话自己的上游空间（0..5）。
      const childBridges = await backend.getSeqMapRows(SessionId("child"));
      expect(childBridges.map((r) => r.fOriginalSeq)).toEqual([0, 1, 2, 3, 4, 5]);
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
      expect(live.snapshotEvents()).toHaveLength(13);

      const snapshot = await provider.rewind(SessionId("live"), 5);
      expect(snapshot.header.id).toBe("live");

      // live 内存 log 截断到边界（含派生缓存与 surface 状态复位）。
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
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
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);

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

  it("rewinds a live session whose log contains dropped delta events (upstream vs dense seq)", async () => {
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      // live 会话：seed 含 assistant/chunk（delta——落盘时被 RDB 过滤，稠密
      // 重编号后 RDB head 落后于 live 上游 head）。上游 seq 0..15（两轮各
      // 6 个 persisted + 2 个 delta）+ 构造时自动补记的 session/end-seed（seq 16）。
      const turn2: SessionEvent[] = oneTurnLog().map(
        (event) =>
          ({
            ...event,
            seq: event.seq + 8,
            time: event.time + 100,
            data: { ...event.data, turn: 2 },
          }) as SessionEvent,
      );
      const seed: SessionEvent[] = [
        ...oneTurnLog(),
        {
          type: "assistant/chunk",
          seq: SessionSeq(6),
          time: 7,
          data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "x" } },
        },
        {
          type: "assistant/chunk",
          seq: SessionSeq(7),
          time: 8,
          data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "y" } },
        },
        ...turn2,
        {
          type: "assistant/chunk",
          seq: SessionSeq(14),
          time: 15,
          data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "z" } },
        },
        {
          type: "assistant/chunk",
          seq: SessionSeq(15),
          time: 16,
          data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "w" } },
        },
      ];
      ctx.sessions.create(SessionId("live-delta"), { meta: meta("live-delta"), seed: [...seed] });
      const live = ctx.sessions.get(SessionId("live-delta"))!;
      await ctx.sessions.flush(live);

      const backend = persistence.internals().backend as unknown as {
        getHead(id: SessionId): Promise<{ fHeadSequence: number }>;
      };
      // live 上游 head = 16；RDB 稠密 head = 12（persisted：轮 1 seq 0..5、
      // 轮 2 seq 8..13、end-seed seq 16；4 个 delta 被过滤）。
      expect(live.snapshotEvents().at(-1)?.seq).toBe(16);
      expect((await backend.getHead(SessionId("live-delta"))).fHeadSequence).toBe(12);

      // 编辑轮 2 → boundary = 轮 1 的 turn/end（上游 seq 5）。修复前此处
      // 误报 "rewind boundary 5 is beyond the stored head 12"。
      const snapshot = await provider.rewind(SessionId("live-delta"), 5);
      expect(snapshot.header.id).toBe("live-delta");

      // live 内存 log 截断到上游边界。
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      // RDB head 截断到稠密目标（轮 1 无 delta 插入中间 → 上游 5 == 稠密 5）。
      expect((await backend.getHead(SessionId("live-delta"))).fHeadSequence).toBe(5);

      // 截断后继续 append 成功（coordinator cursor 已对齐新尾部）。
      const liveAppend = live as unknown as { append(type: string, data: unknown): SessionEvent };
      liveAppend.append("turn/start", { turn: 2 });
      await ctx.sessions.flush(live);
      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect((await backend.getHead(SessionId("live-delta"))).fHeadSequence).toBe(6);
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
    // fork 派生会话（seeded）：rewind 截断进入继承前缀后，`f_seed_length`
    // 必须收缩到保留事件数——否则存储出现「继承前缀超过存储事件数」的矛盾
    // （上游 load 拒绝），且下一次 append 的 upsert 会把旧值写回固化。
    const { ctx, persistence, provider, dispose } = await harness();
    try {
      await createPersisted(ctx, "src", twoTurnLog());
      await provider.forkFrom(SessionId("src"), {
        atSeq: 6,
        anchorMode: "before",
        childSessionId: SessionId("child"),
      });
      // 子会话：继承前缀 6 + 无 seedSuffix = 6 事件（轮 1：seq 0..5）。
      const before = await persistence.load(SessionId("child"));
      expect(before.inheritedEventCount).toBe(6);
      expect(before.events).toHaveLength(6);

      // 截断到轮 1 的 user/message（seq 1，exclusive）：保留 turn/start @0。
      const snapshot = await provider.rewind(SessionId("child"), 1);
      expect(snapshot.header.id).toBe("child");
      // 原始存储事件（loadStored 不补合成 closers）：仅 turn/start @0；
      // 收缩后的继承前缀长度 = 保留事件数（存储自洽）。
      const stored = await persistence.loadStored(SessionId("child"));
      expect(stored).toBeDefined();
      expect(stored!.events).toHaveLength(1);
      expect(stored!.events[0]?.type).toBe("turn/start");
      expect(stored!.inheritedEventCount).toBe(1);
      // 继续 append 后 upsert 不再把旧 seedLength 写回（矛盾不复发）。
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
      await createPersisted(ctx, "s1", [...twoTurnLog(), ...openTail]);

      // rewind 到轮 3 的 user/message（seq 13）：exclusive——该消息及其后
      // （step/start、assistant/message）全部 drop，保留 seq 0..12。
      const snapshot = await provider.rewind(SessionId("s1"), 13);
      expect(snapshot.header.id).toBe("s1");

      // 真实流程：rewind 后立即 append 编辑版重放（完整闭合轮，seq 13 起）。
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
      // 截断前缀（0..12，含 turn/start 12）+ 重放闭合轮（13..18）。
      expect(after.events.map((e) => e.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
      ]);
      expect(after.events[12]?.type).toBe("turn/start");
      expect(after.events[13]?.type).toBe("turn/start");
      expect(after.events[14]?.type).toBe("user/message");
      expect(after.events.at(-1)?.type).toBe("turn/end");
      // 被 drop 的旧 user/message 不在 log 中。
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
      // seq 4 是 step/end——不是合法 rewind 边界。
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
      await createPersisted(ctx, "s1", [...twoTurnLog(), ...openTail]);

      // rewind 到轮 3 的 user/message（seq 14）：exclusive——该消息及其后
      // drop。真实顺序下 step/start（13）在 user/message 之前，会残留为
      // 孤儿（其 step/end 在 drop 区）——修复前 token meter 重放报
      // "step/start ... arrived before turn ... ended"。
      await provider.rewind(SessionId("s1"), 14);

      // 平衡化：孤儿 step/start 被剔除，保留前缀以 turn/start（12）结尾。
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

      // 续写重放轮（完整闭合轮，seq 13 起）后，完整 log 对 token meter 合法。
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
      // 真实 agent-loop 顺序的未闭合轮 3（step/start 在 user/message 之前）。
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
      await createPersisted(ctx, "s1", [...twoTurnLog(), ...openTail]);
      await provider.rewind(SessionId("s1"), 14);

      // 用户 resume 场景：rewind 后直接 load（coordinator 补合成 turn/end，
      // 但不会补孤儿 step/start 的配对——平衡化已把它剔除）。
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
      // 轮 1（seq 0..5 闭合）+ 轮 2（seq 6..11 闭合，含 compaction replace）。
      // 轮 2 的 compaction/summary（seq 10）claim 范围 [1..5]，紧随的
      // assistant/message（seq 11）replace 同一范围。
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
          type: "assistant/message",
          seq: SessionSeq(9),
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
          },
          surfaceOp: { op: "replace", start: 1, end: 3 },
        },
        { type: "step/end", seq: SessionSeq(10), time: 10, data: { turn: 2, step: 1 } },
        {
          type: "turn/end",
          seq: SessionSeq(11),
          time: 11,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ] as unknown as SessionEvent[];
      await createPersisted(ctx, "s1", compacted);

      // rewind 到轮 1 末尾（boundary 5）：轮 2 全部删除，轮 1 保留。
      await provider.rewind(SessionId("s1"), 5);
      const after = await persistence.load(SessionId("s1"));
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(after.events.at(-1)?.type).toBe("turn/end");
      // 保留区无 replace（轮 2 的 replace 被删）——load 必须成功。
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
      // 轮 1（seq 0..5）+ 轮 2（seq 6..11，含 replace [1..5]）+ 轮 3（seq 12..17）。
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
          type: "assistant/message",
          seq: SessionSeq(9),
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
          },
          surfaceOp: { op: "replace", start: 1, end: 3 },
        },
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

      // rewind 到轮 2 末尾（boundary 11）：轮 3 删除，轮 1/2 保留（含 replace）。
      await provider.rewind(SessionId("s1"), 11);
      const after = await persistence.load(SessionId("s1"));
      expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      // 保留区 replace 的 range [1..5] 完整（range 引用更早事件 ⇒ 截断尾部不破坏）。
      const replacement = after.events.find((e) => e.type === "assistant/message" && e.seq === 9)!;
      expect((replacement as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 1, end: 3 });
      // provenance 读取时重计算（覆盖 range 内全部 surface 节点）。
      expect((replacement as SurfaceEvent).sourceEventSeqs).toEqual([1, 3]);
      const meter = new TokenMeter(ctx);
      const session = Session.create(SessionId("s1"), [...after.events]);
      expect(() => meter.measure(session)).not.toThrow();
    } finally {
      await dispose();
    }
  });
});
