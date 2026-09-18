import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { Session, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import {
  closedTurns,
  editableMessages,
  retryableTurns,
} from "@morlay/ui-conversation-message-actions/plan";
import {
  assistantMessage,
  createPersisted,
  harness,
  SessionIdBrand,
  TokenMeter,
  turnLog,
  userMessage,
} from "@morlay/ui-conversation-message-actions/testing";

function rdb(ctx: Context): SessionPersistenceSqlite {
  return ctx.sessionPersistence as SessionPersistenceSqlite;
}

const COMPACTION_ID = "fixture-compaction";

// 从事件序列重建会话读回 surface（模型可见的上下文）：被压缩掉的节点不在 surface 上 === 压缩仍生效。
function surfaceNodes(events: readonly SessionEvent[]): number[] {
  const session = Session.create(SessionIdBrand("probe"), [...events]);
  return [...session.surface.nodes].map((seq) => Number(seq));
}

function outline(events: readonly SessionEvent[]): string[] {
  return events.map((event) => `${String(event.seq)}:${event.type}`);
}

// 对齐 vendor/deepseek-harness/snapshots/acp/image-compaction 的形状：压缩落在「压缩后第一条用户数据」
// 所在的 turn 里，位置在 turn/start 之后、step/start 与该用户消息之前。
// turn 1 / turn 2（长历史）→ turn 3：compaction/start + compaction/summary + 摘要替换消息
// （surface replace 2-9）+ compaction/end → step/start(3,1) → 「第三轮问题」（seq 18）→ turn 4。
function compactedSession(): { events: SessionEvent[]; targetSeq: number } {
  const events = [
    ...turnLog(0, 1, { users: [{ id: "t1-u1", text: "第一轮问题" }], time: 0 }),
    ...turnLog(6, 2, { users: [{ id: "t2-u1", text: "第二轮问题" }], time: 6 }),
    { type: "turn/start", seq: SessionSeq(12), time: 12, data: { turn: 3 } },
    {
      type: "compaction/start",
      seq: SessionSeq(13),
      time: 13,
      data: { compactionId: COMPACTION_ID, turn: 3 },
    },
    {
      type: "compaction/summary",
      seq: SessionSeq(14),
      time: 14,
      data: {
        compactionId: COMPACTION_ID,
        summary: [{ type: "text", text: "前两轮摘要" }],
        shadowedRange: { start: 2, end: 9 },
        shadowedSeqs: [2, 3, 8, 9],
        shadowedTokenCount: 40,
        provider: "mock",
        model: "mock",
      },
    },
    {
      type: "user/message",
      seq: SessionSeq(15),
      time: 15,
      data: {
        id: "t3-compacted-summary",
        role: "user",
        content: [{ type: "text", text: "前两轮摘要" }],
        source: { kind: "plugin", plugin: "compact", compactionId: COMPACTION_ID },
      },
      surfaceOp: { op: "replace", startSeq: 2, endSeq: 9 },
      sourceEventSeqs: [13, 14, 2, 3, 8, 9],
    },
    {
      type: "compaction/end",
      seq: SessionSeq(16),
      time: 16,
      data: { compactionId: COMPACTION_ID, turn: 3 },
    },
    { type: "step/start", seq: SessionSeq(17), time: 17, data: { turn: 3, step: 1 } },
    userMessage(18, "t3-u1", "第三轮问题", 18),
    assistantMessage(19, 3, 1, "t3-a1", "第三轮回答", 19),
    { type: "step/end", seq: SessionSeq(20), time: 20, data: { turn: 3, step: 1 } },
    {
      type: "turn/end",
      seq: SessionSeq(21),
      time: 21,
      data: { turn: 3, reason: { kind: "completed" } },
    },
    ...turnLog(22, 4, { users: [{ id: "t4-u1", text: "第四轮问题" }], time: 22 }),
  ] as unknown as SessionEvent[];
  return { events, targetSeq: 18 };
}

// 压缩之前的 turn/end：rewind / retry / edit 对「压缩后第一条用户数据」选中的边界。
const BEFORE_COMPACTION = [
  "0:turn/start",
  "1:step/start",
  "2:user/message",
  "3:assistant/message",
  "4:step/end",
  "5:turn/end",
  "6:turn/start",
  "7:step/start",
  "8:user/message",
  "9:assistant/message",
  "10:step/end",
  "11:turn/end",
];

// 补回的压缩：standalone 形态（不属于任何 turn），摘要替换仍覆盖 2-9。
const RESTORED_COMPACTION = [
  "compaction/start",
  "compaction/summary",
  "user/message",
  "compaction/end",
];

async function afterOperation(ctx: Context, id: SessionIdBrand): Promise<SessionEvent[]> {
  const stored = await rdb(ctx).load(id);
  const after = [...stored.events];
  // 补回的压缩事件顺序与原始压缩一致
  expect(after.slice(-RESTORED_COMPACTION.length).map((event) => event.type)).toEqual(
    RESTORED_COMPACTION,
  );
  return after;
}

describe("压缩后第一条用户数据的 rewind / retry / edit", () => {
  it("recall：压缩留在保留前缀里，之后的输入全部撤回", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const { events, targetSeq } = compactedSession();
      await createPersisted(ctx, "src", events);

      await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("src"),
        eventSeq: targetSeq,
      });

      const after = await afterOperation(ctx, SessionIdBrand("src"));
      expect(outline(after)).toEqual([
        ...BEFORE_COMPACTION,
        "12:compaction/start",
        "13:compaction/summary",
        "14:user/message",
        "15:compaction/end",
      ]);
      // 2/3/8/9 仍被摘要替换遮蔽（压缩没被忽略），模型看到的是压缩点
      expect(surfaceNodes(after)).toEqual([14]);
    } finally {
      await dispose();
    }
  });

  it("retry：压缩留在保留前缀里，只重放该回合的输入", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const { events } = compactedSession();
      await createPersisted(ctx, "src", events);

      const result = await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("src"),
        turn: 3,
        cascade: "truncate",
      });

      const after = await afterOperation(ctx, SessionIdBrand("src"));
      expect(outline(after)).toEqual([
        ...BEFORE_COMPACTION,
        "12:session-branch/version",
        "13:compaction/start",
        "14:compaction/summary",
        "15:user/message",
        "16:compaction/end",
      ]);
      expect(surfaceNodes(after)).toEqual([15]);
      expect(() =>
        new TokenMeter(ctx).measure(Session.create(SessionIdBrand("src"), after)),
      ).not.toThrow();
      // 版本效果记在同一个会话上（ADR-就地编辑重写同一会话而非新建会话），重放的输入交给 agent（ADR-重放经agent驱动而非直接append回复）
      expect(result).toMatchObject({ sessionId: "src", queuedTurns: 0 });
    } finally {
      await dispose();
    }
  });

  it("edit：压缩留在保留前缀里，只重放编辑后的输入", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      const { events, targetSeq } = compactedSession();
      await createPersisted(ctx, "src", events);

      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("src"),
        eventSeq: targetSeq,
        blockIndex: 0,
        text: "第三轮问题（已编辑）",
        cascade: "truncate",
      });

      const after = await afterOperation(ctx, SessionIdBrand("src"));
      expect(outline(after)).toEqual([
        ...BEFORE_COMPACTION,
        "12:session-branch/version",
        "13:compaction/start",
        "14:compaction/summary",
        "15:user/message",
        "16:compaction/end",
      ]);
      expect(surfaceNodes(after)).toEqual([15]);

      const turns = closedTurns(after);
      expect(turns.map((turn) => turn.turn)).toEqual([1, 2]);
      expect(retryableTurns(turns).map((turn) => turn.preview)).toEqual([
        "第一轮问题",
        "第二轮问题",
      ]);
      expect(editableMessages(turns).filter((block) => block.kind === "user")).toHaveLength(2);
    } finally {
      await dispose();
    }
  });
});
