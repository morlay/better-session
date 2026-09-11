import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import {
  harness,
  meta,
  oneTurnLog,
  turnLog,
  SessionIdBrand,
  SessionSeq,
  type SessionEvent as Event,
} from "@morlay/ui-conversation-message-actions/testing";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function appendable(session: Session) {
  return session as unknown as {
    append(type: string, data: unknown, opts?: unknown): Event;
  };
}

function userText(message: UserMessage): string {
  return message.content
    .filter(
      (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function turnsOf(events: readonly SessionEvent[]): number[] {
  return events.flatMap((event) => (event.type === "turn/start" ? [event.data.turn] : []));
}

function inboxPending(session: Session): UserMessage[] {
  let pending: UserMessage[] = [];
  for (const event of session.snapshotEvents()) {
    // agent-loop 的事件类型未并入本包的类型图，按类型名比较。
    if (String(event.type) !== "agent/inbox/spliced") continue;
    const data = (
      event as unknown as {
        data: {
          target: string;
          start: number;
          removedCount?: number;
          inserted: UserMessage[];
        };
      }
    ).data;
    if (data.target !== "next-turn") continue;
    pending = pending.toSpliced(data.start, data.removedCount ?? 0, ...data.inserted);
  }
  return pending;
}

/**
 * 迷你 agent：复刻真实 agent-loop 的关键行为——轮号取 phase.lastTurn + 1
 * （rewind 会通过 duck-type 重置该游标），followup 产生完整轮次事件，
 * inbox.clear 按保留区 pending 落一条 canceled splice。
 */
function miniAgent(session: Session) {
  const lastTurn = session.snapshotEvents().findLast((event) => event.type === "turn/start")
    ?.data.turn;
  const agent = {
    session,
    requestHeaderLogged: false,
    phase: { lastTurn: lastTurn ?? 0 },
    inbox: {
      clear: () => {
        const pending = inboxPending(session);
        if (pending.length === 0) return;
        appendable(session).append("agent/inbox/spliced", {
          target: "next-turn",
          start: 0,
          removedCount: pending.length,
          inserted: [],
          outcome: "canceled",
        });
      },
    },
    received: [] as string[],
    followup(message: UserMessage): void {
      agent.received.push(userText(message));
      agent.phase.lastTurn += 1;
      const turn = agent.phase.lastTurn;
      appendable(session).append("turn/start", { turn });
      appendable(session).append("step/start", { turn, step: 1 });
      appendable(session).append("user/message", message, { surfaceOp: "append" });
      appendable(session).append(
        "assistant/message",
        {
          turn,
          step: 1,
          message: {
            id: `assistant-${String(turn)}`,
            role: "assistant",
            content: [{ type: "text", text: `answer-${String(turn)}` }],
            source: { kind: "model", provider: "mock", model: "mock" },
          },
          stream: [],
        },
        { surfaceOp: "append" },
      );
      appendable(session).append("step/end", { turn, step: 1 });
      appendable(session).append("turn/end", { turn, reason: { kind: "completed" } });
    },
    whenIdle: async (): Promise<void> => {},
  };
  return agent;
}

function provideAgents(ctx: Context, agent: ReturnType<typeof miniAgent>): () => void {
  return ctx.provide("agents", {
    get: (id: string) => (id === String(agent.session.id) ? agent : undefined),
    create: async () => {
      throw new Error("unused");
    },
    resume: async () => {
      throw new Error("unused");
    },
  });
}

async function liveSession(ctx: Context, id: string, events: readonly SessionEvent[]) {
  ctx.sessions.create(SessionIdBrand(id), { meta: meta(id), seed: [...events] });
  const live = ctx.sessions.get(SessionIdBrand(id))!;
  await ctx.sessions.flush(live);
  return live;
}

const header: SessionEvent = {
  type: "request/header",
  seq: SessionSeq(0),
  time: 1,
  data: { header: { config: { provider: "mock", model: "mock" } }, reason: "initial" },
} as unknown as SessionEvent;

const threeTurns = (): SessionEvent[] => [
  header,
  ...turnLog(1, 1),
  ...turnLog(7, 2),
  ...turnLog(13, 3),
];

/** 空轮：turn/start 后直接 turn/end（早期重放缺陷的遗留形状）。 */
function emptyTurn(base: number, turn: number): SessionEvent[] {
  return [
    { type: "turn/start", seq: SessionSeq(base), time: base, data: { turn } },
    {
      type: "turn/end",
      seq: SessionSeq(base + 1),
      time: base + 1,
      data: { turn, reason: { kind: "completed" } },
    },
  ] as unknown as SessionEvent[];
}

function pendingSplice(seq: number, text: string): SessionEvent {
  return {
    type: "agent/inbox/spliced",
    seq: SessionSeq(seq),
    time: seq,
    data: {
      target: "next-turn",
      start: 0,
      inserted: [
        {
          id: `pending-${String(seq)}`,
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user" },
        },
      ],
    },
  } as unknown as SessionEvent;
}

describe("SessionEditor replay turn numbering", () => {
  it("retry of a middle turn reuses the target turn number", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", threeTurns());
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("s"),
        turn: 2,
        cascade: "truncate",
      });
      expect(agent.received).toEqual(["turn 2 input"]);
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("edit of a middle user message reuses the target turn number", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", threeTurns());
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("s"),
        eventSeq: 9,
        blockIndex: 0,
        text: "edited2",
        cascade: "truncate",
      });
      expect(agent.received).toEqual(["edited2"]);
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("edit of an assistant block keeps downstream replay on the next turn number", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", threeTurns());
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("s"),
        eventSeq: 10,
        blockIndex: 0,
        text: "edited assistant",
        cascade: "preserve",
      });
      expect(agent.received).toEqual(["turn 3 input"]);
      // manualTurn 写入 turn 2，重放必须接 turn 3，不得重复。
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2, 3]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("edit of a first user message in an open turn reuses the open turn number", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const openTail: SessionEvent[] = [
        { type: "turn/start", seq: SessionSeq(19), time: 20, data: { turn: 4 } },
        { type: "step/start", seq: SessionSeq(20), time: 21, data: { turn: 4, step: 1 } },
        {
          type: "user/message",
          seq: SessionSeq(21),
          time: 22,
          data: {
            id: "open-user",
            role: "user",
            content: [{ type: "text", text: "open input" }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        } as unknown as SessionEvent,
      ];
      const live = await liveSession(ctx, "s", [...threeTurns(), ...openTail]);
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("s"),
        eventSeq: 21,
        blockIndex: 0,
        text: "open edited",
        cascade: "truncate",
      });
      expect(agent.received).toEqual(["open edited"]);
      // 悬空 turn/start 不得残留：整轮截断后重放仍是 turn 4。
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2, 3, 4]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("edit after a surviving pending splice keeps seq contiguous (cancel lands before the version effect)", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", [
        header,
        ...turnLog(1, 1),
        pendingSplice(7, "pending"),
        ...turnLog(8, 2),
        ...turnLog(14, 3),
      ]);
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("s"),
        eventSeq: 16,
        blockIndex: 0,
        text: "edited3",
        cascade: "truncate",
      });
      const events = live.snapshotEvents();
      expect(events.map((event) => event.seq)).toEqual([...Array(events.length).keys()]);
      const lastSplice = events.findLast((event) => String(event.type) === "agent/inbox/spliced");
      expect((lastSplice?.data as { outcome?: string } | undefined)?.outcome).toBe("canceled");
      expect(turnsOf(events)).toEqual([1, 2, 3]);
      expect(agent.received).toEqual(["edited3"]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("retry of the first turn replays only that turn", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", threeTurns());
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("s"),
        turn: 1,
        cascade: "truncate",
      });
      expect(agent.received).toEqual(["turn 1 input"]);
      expect(turnsOf(live.snapshotEvents())).toEqual([1]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("preserve retry replays the target turn and every downstream turn input", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", threeTurns());
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("s"),
        turn: 2,
        cascade: "preserve",
      });
      expect(agent.received).toEqual(["turn 2 input", "turn 3 input"]);
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2, 3]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("retry after an empty turn absorbs it and replays continuously", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // turn1（内容）→ turn2（空轮）→ turn3（内容）：重试 turn3 应把空轮
      // 一并截断，重放成 turn2，而不是留下 1,2,3 里的空 turn2。
      const live = await liveSession(ctx, "s", [
        header,
        ...turnLog(1, 1),
        ...emptyTurn(7, 2),
        ...turnLog(9, 3),
      ]);
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("s"),
        turn: 3,
        cascade: "truncate",
      });
      expect(agent.received).toEqual(["turn 3 input"]);
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("assistant edit after an empty turn writes the manual turn continuously", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", [
        header,
        ...turnLog(1, 1),
        ...emptyTurn(7, 2),
        ...turnLog(9, 3),
      ]);
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      // turnLog(9, 3) 的 assistant/message 在 seq 12。
      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("s"),
        eventSeq: 12,
        blockIndex: 0,
        text: "edited assistant 3",
        cascade: "truncate",
      });
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });
});

describe("SessionEditor replay on cold sessions", () => {
  it("cold edit resumes and replays the edited input on the reused turn number", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const handle = await ctx.sessionPersistence.create(meta("cold"));
      await handle.append([...threeTurns()]);
      await handle.close();
      expect(ctx.sessions.get(SessionIdBrand("cold"))).toBeUndefined();

      let resumed = 0;
      let resumedAgent: ReturnType<typeof miniAgent> | undefined;
      const disposeAgents = ctx.provide("agents", {
        // 真实 resume 会把 agent 注册进 registry，rewind 才能重置其轮次游标。
        get: (id: string) =>
          resumedAgent !== undefined && id === String(resumedAgent.session.id)
            ? resumedAgent
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          resumed += 1;
          const stored = await (ctx.sessionPersistence as SessionPersistenceSqlite).load(
            SessionIdBrand("cold"),
          );
          ctx.sessions.create(SessionIdBrand("cold"), {
            meta: stored.meta,
            seed: [...stored.events],
          });
          const live = ctx.sessions.get(SessionIdBrand("cold"))!;
          resumedAgent = miniAgent(live);
          return { agent: resumedAgent, dispose: async () => {} };
        },
      });

      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("cold"),
        eventSeq: 9,
        blockIndex: 0,
        text: "edited2",
        cascade: "truncate",
      });
      const live = ctx.sessions.get(SessionIdBrand("cold"))!;
      expect(resumed).toBe(1);
      expect(turnsOf(live.snapshotEvents())).toEqual([1, 2]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });
});

describe("SessionEditor replay against oneTurnLog fixtures", () => {
  it("retry on a single-turn session replays turn 1", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const live = await liveSession(ctx, "s", oneTurnLog());
      const agent = miniAgent(live);
      const disposeAgents = provideAgents(ctx, agent);
      await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("s"),
        turn: 1,
        cascade: "truncate",
      });
      expect(agent.received).toEqual(["hi"]);
      expect(turnsOf(live.snapshotEvents())).toEqual([1]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });
});
