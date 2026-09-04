import { Context } from "@deepseek-ai/cordis";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import {
  Session,
  SessionId as SessionIdBrand,
  SessionSeq,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { type BranchTimeline } from "@morlay/session-branch";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { parseJsonlArtifact } from "@morlay/session-rdb/artifact";
import { EmptySettings, meta, oneTurnLog } from "@morlay/session-rdb/testing";
import { SessionEditor } from "@morlay/ui-conversation-message-actions";

export {
  BranchTimeline,
  Session,
  SessionIdBrand,
  SessionSeq,
  SessionStore,
  TokenMeter,
  EmptySettings,
  meta,
  oneTurnLog,
  parseJsonlArtifact,
};
export type { SessionEvent, SessionHeader };

export interface Harness {
  ctx: Context;
  editor: SessionEditor;
  dispose: () => Promise<void>;
}

export async function harness(): Promise<Harness> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  await ctx.plugin(SessionEditor);
  return { ctx, editor: ctx.sessionEditor, dispose: () => fiber.dispose() };
}

export function twoTurnLog(): SessionEvent[] {
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

export async function createPersisted(
  ctx: Context,
  id: string,
  events: readonly SessionEvent[],
  header: SessionHeader = meta(id),
): Promise<void> {
  await ctx.sessionPersistence.create(header);
  await ctx.sessionPersistence.append(SessionIdBrand(id), [...events]);
}

/** 构造一条 user/message 事件。 */
export function userMessage(
  seq: number,
  id: string,
  text: string,
  time = seq,
): SessionEvent {
  return {
    type: "user/message",
    seq: SessionSeq(seq),
    time,
    data: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    },
    surfaceOp: "append",
  } as SessionEvent;
}

/** 构造一条 assistant/message 事件（纯文本回复）。 */
export function assistantMessage(
  seq: number,
  turn: number,
  step: number,
  id: string,
  text: string,
  time = seq,
): SessionEvent {
  return {
    type: "assistant/message",
    seq: SessionSeq(seq),
    time,
    data: {
      turn,
      step,
      message: {
        id,
        role: "assistant",
        content: [{ type: "text", text }],
        source: { kind: "model", provider: "mock", model: "mock" },
      },
    },
    surfaceOp: "append",
  } as SessionEvent;
}

/** 真实 agent-loop 形状的一轮：轮首输入 + 可选 followup，可闭合。 */
export function turnLog(
  base: number,
  turn: number,
  opts: { users?: Array<{ id: string; text: string }>; closed?: boolean; time?: number } = {},
): SessionEvent[] {
  const { closed = true, time = base } = opts;
  const users = opts.users ?? [{ id: `t${turn}-u1`, text: `turn ${turn} input` }];
  const events: SessionEvent[] = [
    { type: "turn/start", seq: SessionSeq(base), time, data: { turn } },
  ];
  let seq = base + 1;
  let step = 1;
  for (const user of users) {
    events.push({ type: "step/start", seq: SessionSeq(seq++), time, data: { turn, step } });
    events.push(userMessage(seq++, user.id, user.text, time));
    events.push(
      assistantMessage(seq++, turn, step, `${user.id}-a`, `answer to ${user.text}`, time),
    );
    events.push({ type: "step/end", seq: SessionSeq(seq++), time, data: { turn, step } });
    step += 1;
  }
  if (closed) {
    events.push({
      type: "turn/end",
      seq: SessionSeq(seq++),
      time,
      data: { turn, reason: { kind: "completed" } },
    });
  }
  return events;
}
