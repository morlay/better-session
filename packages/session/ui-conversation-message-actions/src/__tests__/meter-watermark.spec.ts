import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { TokenMeasurement } from "@deepseek-ai/dsh-token-meter";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { appendLog } from "@morlay/session-rdb/testing";
import {
  harness,
  meta,
  SessionIdBrand,
  TokenMeter,
  turnLog,
} from "@morlay/ui-conversation-message-actions/testing";

// 上游 TokenMeter 把折叠水位放在私有 states: WeakMap<Session, {consumedEvents}> 里（token-meter
// 的 ReplayState）；测试只读它来验证「失效是否真的发生」——失效后水位必须等于当前 log 长度。
function foldedWatermark(meter: TokenMeter, session: Session): number | undefined {
  const states = (meter as unknown as { states: WeakMap<Session, { consumedEvents: number }> })
    .states;
  return states.get(session)?.consumedEvents;
}

// 上游 TokenMeter 是 ctx 单例服务（同一 ctx 只能注册一个），「全新实例」的折叠结果在独立 ctx 上算
// （measure 只读会话日志与可选的 llm 服务）。
function freshMeasurement(session: Session): TokenMeasurement {
  const probe = new Context();
  new SessionProjectionRegistry(probe);
  return new TokenMeter(probe).measure(session);
}

// 同一个 meter 实例的折叠结果必须与全新实例一致：水位留在被截断的旧日志上会漏折或错折
function expectMeterUpToDate(meter: TokenMeter, session: Session): void {
  const measurement = meter.measure(session);
  expect(measurement.logRevision).toBe(session.snapshotEvents().length);
  expect(measurement).toEqual(freshMeasurement(session));
  expect(foldedWatermark(meter, session)).toBe(session.snapshotEvents().length);
}

describe("rewound live session with a warm token meter", () => {
  it("survives edit, retry and recall chained on one meter instance", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      // turn 1 有两个输入（10 个事件）→ turn 2（6）→ turn 3（6）
      const seed: SessionEvent[] = [
        ...turnLog(0, 1, {
          users: [
            { id: "t1-u1", text: "第一轮问题" },
            { id: "t1-u2", text: "第一轮追问" },
          ],
        }),
        ...turnLog(10, 2),
        ...turnLog(16, 3),
      ];
      ctx.sessions.create(SessionIdBrand("live"), { meta: meta("live"), seed: [...seed] });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const meter = new TokenMeter(ctx);
      meter.measure(live);
      expect(foldedWatermark(meter, live)).toBe(live.snapshotEvents().length);

      await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 18,
        blockIndex: 0,
        text: "第三轮问题（已编辑）",
        cascade: "truncate",
      });
      await editor.retry({
        action: "retry",
        sessionId: SessionIdBrand("live"),
        turn: 2,
        cascade: "truncate",
      });
      const recalled = await editor.recall({
        action: "recall",
        sessionId: SessionIdBrand("live"),
        eventSeq: 6,
      });
      expect(recalled.sessionId).toBe(SessionIdBrand("live"));

      expect(live.snapshotEvents().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
      expectMeterUpToDate(meter, live);
    } finally {
      await dispose();
    }
  });

  it("survives a real agent-loop continuation that grows the log past the old watermark", async () => {
    const { ctx, editor, dispose } = await harness();
    try {
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        seed: [...turnLog(0, 1), ...turnLog(6, 2)],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      const meter = new TokenMeter(ctx);
      meter.measure(live);

      const followups: unknown[] = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionId) =>
          id === SessionIdBrand("live")
            ? {
                session: live,
                followup: (message: unknown) => {
                  followups.push(message);
                  // 真实 loop 的续写：followup 之后日志从被截断处重新长过旧水位
                  const base = live.snapshotEvents().length;
                  appendLog(live, [
                    ...turnLog(base, 3),
                    ...turnLog(base + 6, 4),
                    ...turnLog(base + 12, 5),
                  ]);
                },
                whenIdle: async () => {},
                inbox: { clear: () => {} },
              }
            : undefined,
        create: async () => {
          throw new Error("unused");
        },
        resume: async () => {
          throw new Error("unused");
        },
      });

      const edited = await editor.edit({
        action: "edit",
        sessionId: SessionIdBrand("live"),
        eventSeq: 2,
        blockIndex: 0,
        text: "第一轮问题（已编辑）",
        cascade: "truncate",
      });
      expect(edited.queuedTurns).toBe(1);
      expect(followups).toHaveLength(1);
      expect(live.snapshotEvents().length).toBeGreaterThan(13);

      expectMeterUpToDate(meter, live);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("stays measurable at the compaction entry after a manual rewind", async () => {
    const { ctx, dispose } = await harness();
    try {
      ctx.sessions.create(SessionIdBrand("live"), {
        meta: meta("live"),
        // turn 3 只落了 step/start（中断运行的形状）：预热后折叠状态里有未闭合的 step 3/1
        seed: [...turnLog(0, 1), ...turnLog(6, 2), ...turnLog(12, 3).slice(0, 2)],
      });
      const live = ctx.sessions.get(SessionIdBrand("live"))!;
      await ctx.sessions.flush(live);

      // 手动 /compact 的入口：compaction-basic.compactIfNeeded 第一条语句就是 ctx.tokenMeter.measure(session)
      const meter = new TokenMeter(ctx);
      meter.measure(live);

      await ctx.sessionBranch.rewind(SessionIdBrand("live"), 11);
      const base = live.snapshotEvents().length;
      appendLog(live, [...turnLog(base, 4), ...turnLog(base + 6, 5)]);
      await ctx.sessions.flush(live);
      expect(live.snapshotEvents().length).toBeGreaterThan(19);

      expect(() => meter.measure(live)).not.toThrow();
      expectMeterUpToDate(meter, live);
    } finally {
      await dispose();
    }
  });
});
