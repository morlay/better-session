import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import {
  SESSION_BRANCH_VERSION_SCHEMA,
  SessionBranchError,
  type EditableBlockKind,
  type SessionBranchEffect,
  type SessionBranchVersionEvent,
} from "@morlay/session-branch";
import type {
  EditOperation,
  EditableMessageBlock,
  RerollOperation,
  RetryOperation,
  RetryableTurn,
} from "./types.ts";

export interface ClosedTurn {
  turn: number;
  startSeq: number;

  endSeq?: number;

  closed: boolean;
  user?: SessionEvent<"user/message">;

  users: SessionEvent<"user/message">[];
  assistants: SessionEvent<"assistant/message">[];
}

export interface OperationPlan {
  anchorSeq: number;

  rewindBoundary?: number;
  version: SessionBranchVersionEvent;

  manualTurn?: { turn: number; user: UserMessage; assistant: AssistantMessage };

  queuedUsers: UserMessage[];

  // 操作目标事件（被重放或撤回的那条）的 seq
  targetSeq: number;
}

function isTextualBlock(
  block: ContentBlock | undefined,
): block is Extract<ContentBlock, { type: "text" | "reasoning" }> {
  return block?.type === "text" || block?.type === "reasoning";
}

function userText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function cloneUser(
  message: UserMessage,
  content: ContentBlock[] = structuredClone(message.content),
): UserMessage {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze(content),
    source: Object.freeze({ kind: "user" }),
  }) as UserMessage;
}

function replaceTextBlock(
  content: readonly ContentBlock[],
  blockIndex: number,
  text: string,
): ContentBlock[] {
  const block = content[blockIndex];
  if (!isTextualBlock(block))
    throw new SessionBranchError("所选内容块不是可编辑文本。", "INVALID_BOUNDARY");
  return content.map((candidate, index) =>
    index === blockIndex ? ({ ...candidate, text } as ContentBlock) : structuredClone(candidate),
  );
}

export function closedTurns(events: readonly SessionEvent[]): ClosedTurn[] {
  const result: ClosedTurn[] = [];
  let current: Omit<ClosedTurn, "endSeq" | "closed"> | undefined;
  for (const event of events) {
    if (event.type === "turn/start") {
      current = { turn: event.data.turn, startSeq: event.seq, users: [], assistants: [] };
      continue;
    }
    if (current === undefined) continue;
    if (event.type === "user/message" && event.data.source.kind === "user") {
      if (current.user === undefined) current.user = event;
      current.users.push(event);
      continue;
    }
    if (event.type === "assistant/message" && event.data.turn === current.turn) {
      current.assistants.push(event);
      continue;
    }
    if (event.type === "turn/end" && event.data.turn === current.turn) {
      result.push({ ...current, endSeq: event.seq, closed: true });
      current = undefined;
    }
  }

  if (current !== undefined) result.push({ ...current, closed: false });
  return result;
}

export function editableMessages(turns: readonly ClosedTurn[]): EditableMessageBlock[] {
  const result: EditableMessageBlock[] = [];
  for (const turn of turns) {
    for (const user of turn.users) {
      for (const [blockIndex, block] of user.data.content.entries()) {
        if (block.type !== "text") continue;
        result.push({
          key: `${String(user.seq)}:${String(blockIndex)}`,
          turn: turn.turn,
          eventSeq: user.seq,
          blockIndex,
          kind: "user",
          text: block.text,
          time: user.time,
        });
      }
    }

    if (!turn.closed) continue;
    for (const event of turn.assistants) {
      for (const [blockIndex, block] of event.data.message.content.entries()) {
        if (!isTextualBlock(block)) continue;
        result.push({
          key: `${String(event.seq)}:${String(blockIndex)}`,
          turn: turn.turn,
          eventSeq: event.seq,
          blockIndex,
          kind: block.type === "reasoning" ? "assistant.reasoning" : "assistant.response",
          text: block.text,
          time: event.time,
        });
      }
    }
  }
  return result;
}

export function retryableTurns(turns: readonly ClosedTurn[]): RetryableTurn[] {
  return turns.flatMap((turn): RetryableTurn[] =>
    turn.user === undefined || !turn.closed
      ? []
      : [
          {
            turn: turn.turn,
            userEventSeq: turn.user.seq,
            preview: userText(turn.user.data),
            time: turn.user.time,
          },
        ],
  );
}

export function precedingContentIndex(turns: readonly ClosedTurn[], turnIndex: number): number {
  let index = turnIndex - 1;
  while (index >= 0) {
    const turn = turns[index]!;
    if (turn.users.length > 0 || turn.assistants.length > 0) break;
    index -= 1;
  }
  return index;
}

export function downstreamUsers(turns: readonly ClosedTurn[], start: number): UserMessage[] {
  return turns
    .slice(start)
    .flatMap((turn): UserMessage[] => turn.users.map((user) => cloneUser(user.data)));
}

export function recallBoundary(
  events: readonly SessionEvent[],
  turns: readonly ClosedTurn[],
  eventSeq: number,
): number {
  const turnIndex = turns.findIndex(
    (turn) => eventSeq > turn.startSeq && (turn.endSeq === undefined || eventSeq < turn.endSeq),
  );
  const turn = turns[turnIndex];
  if (turn === undefined) {
    const target = events.find((event) => event.seq === eventSeq);
    if (target?.type !== "user/message" || target.data.source.kind !== "user")
      throw new SessionBranchError("所选消息不属于已落定回合。", "INVALID_BOUNDARY");
    return eventSeq;
  }
  const userIndex = turn.users.findIndex((user) => user.seq === eventSeq);
  if (userIndex === -1)
    throw new SessionBranchError("所选消息不存在或不可撤回。", "INVALID_BOUNDARY");
  const preceding = precedingContentIndex(turns, turnIndex);
  return userIndex === 0 ? (preceding < 0 ? -1 : turns[preceding]!.endSeq!) : eventSeq;
}

function assistantReplacement(
  event: SessionEvent<"assistant/message">,
  blockIndex: number,
  text: string,
): AssistantMessage {
  const replaced = replaceTextBlock(event.data.message.content, blockIndex, text).filter(
    (block) => block.type === "text" || block.type === "reasoning",
  );
  return Object.freeze({
    id: randomUUID(),
    role: "assistant",
    content: Object.freeze(replaced),
    source: Object.freeze({
      kind: "model",
      provider: event.data.message.source.provider,
      model: event.data.message.source.model,
    }),
  }) as AssistantMessage;
}

function pairVersionEffect(
  sourceSessionId: SessionId,
  effect: Omit<SessionBranchEffect, "id">,
): SessionBranchVersionEvent {
  return {
    schemaVersion: SESSION_BRANCH_VERSION_SCHEMA,
    effect: { ...effect, id: randomUUID() },
    inverse: { kind: "restore-version", sessionId: sourceSessionId },
  };
}

export function editPlan(operation: EditOperation, turns: readonly ClosedTurn[]): OperationPlan {
  const turnIndex = turns.findIndex(
    (turn) =>
      operation.eventSeq > turn.startSeq &&
      (turn.endSeq === undefined || operation.eventSeq < turn.endSeq),
  );
  const turn = turns[turnIndex];
  if (turn === undefined)
    throw new SessionBranchError("所选消息不属于已落定回合。", "INVALID_BOUNDARY");
  const event =
    turn.users.find((candidate) => candidate.seq === operation.eventSeq) ??
    turn.assistants.find((candidate) => candidate.seq === operation.eventSeq);
  if (event === undefined)
    throw new SessionBranchError("所选消息不存在或不可编辑。", "INVALID_BOUNDARY");

  if (event.type === "user/message") {
    const before = event.data.content[operation.blockIndex];
    if (before?.type !== "text")
      throw new SessionBranchError("所选用户消息块不是文本。", "INVALID_BOUNDARY");
    const edited = cloneUser(
      event.data,
      replaceTextBlock(event.data.content, operation.blockIndex, operation.text),
    );

    const userIndex = turn.users.findIndex((candidate) => candidate.seq === event.seq);
    const sameTurnFollowups = turn.users.slice(userIndex + 1).map((user) => cloneUser(user.data));
    const later = operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : [];
    return {
      anchorSeq: turn.startSeq,

      ...(userIndex === 0 ? {} : { rewindBoundary: event.seq }),
      version: pairVersionEffect(operation.sessionId, {
        operation: "edit",
        cascade: operation.cascade,
        targetTurn: turn.turn,
        targetEventSeq: event.seq,
        targetBlockIndex: operation.blockIndex,
        blockKind: "user",
        before: before.text,
        after: operation.text,
      }),
      queuedUsers: [edited, ...sameTurnFollowups, ...later],
      targetSeq: event.seq,
    };
  }

  if (!turn.closed)
    throw new SessionBranchError("未闭合轮次的助手消息不可编辑。", "INVALID_BOUNDARY");
  const before = event.data.message.content[operation.blockIndex];
  if (!isTextualBlock(before))
    throw new SessionBranchError("所选助手消息块不是文本或思考。", "INVALID_BOUNDARY");
  const blockKind: EditableBlockKind =
    before.type === "reasoning" ? "assistant.reasoning" : "assistant.response";
  if (turn.user === undefined)
    throw new SessionBranchError("所选助手消息没有可重建的用户输入。", "INVALID_BOUNDARY");
  return {
    anchorSeq: turn.startSeq,
    version: pairVersionEffect(operation.sessionId, {
      operation: "edit",
      cascade: operation.cascade,
      targetTurn: turn.turn,
      targetEventSeq: event.seq,
      targetBlockIndex: operation.blockIndex,
      blockKind,
      before: before.text,
      after: operation.text,
    }),
    manualTurn: {
      turn: turn.turn,
      user: cloneUser(turn.user.data),
      assistant: assistantReplacement(event, operation.blockIndex, operation.text),
    },
    queuedUsers: operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : [],
    targetSeq: event.seq,
  };
}

export function retryPlan(operation: RetryOperation, turns: readonly ClosedTurn[]): OperationPlan {
  const turnIndex = turns.findIndex((turn) => turn.turn === operation.turn);
  const turn = turns[turnIndex];
  if (turn?.user === undefined)
    throw new SessionBranchError("所选回合没有可重放的用户输入。", "INVALID_BOUNDARY");
  return {
    anchorSeq: turn.startSeq,
    version: pairVersionEffect(operation.sessionId, {
      operation: "retry",
      cascade: operation.cascade,
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
    }),
    queuedUsers:
      operation.cascade === "preserve"
        ? downstreamUsers(turns, turnIndex)
        : turn.users.map((user) => cloneUser(user.data)),
    targetSeq: turn.user.seq,
  };
}

export function rerollPlan(
  operation: RerollOperation,
  turns: readonly ClosedTurn[],
): OperationPlan {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];

    if (turn?.user === undefined || !turn.closed) continue;
    const target = turn.assistants.findLast((event) =>
      event.data.message.content.some(isTextualBlock),
    );
    if (target === undefined) continue;
    return {
      anchorSeq: turn.startSeq,
      version: pairVersionEffect(operation.sessionId, {
        operation: "reroll",
        cascade: "truncate",
        targetTurn: turn.turn,
        targetEventSeq: target.seq,
      }),
      queuedUsers: turn.users.map((user) => cloneUser(user.data)),
      targetSeq: target.seq,
    };
  }
  throw new SessionBranchError("当前会话没有可重生成的已落定助手回复。", "INVALID_BOUNDARY");
}

export interface CompactionBracket {
  start: SessionEvent;
  summary?: SessionEvent;
  checkpoint: SessionEvent;
  end: SessionEvent;
}

const COMPACTION_TYPES: ReadonlySet<string> = new Set([
  "compaction/start",
  "compaction/summary",
  "compaction/end",
]);

// 本包不加载 compaction 的事件类型增强，按类型字符串与结构性字段读取（与 session-rdb 的 schema、log 同一处理方式）。
function compactionTypeOf(event: SessionEvent): string | undefined {
  return COMPACTION_TYPES.has(event.type) ? event.type : undefined;
}

// 压缩事务的替换消息：compact 插件写入的 surface replace 用户消息（checkpoint）。
function isCompactionCheckpoint(event: SessionEvent): boolean {
  if (event.type !== "user/message") return false;
  const op = (event as unknown as { surfaceOp?: unknown }).surfaceOp;
  if (typeof op !== "object" || op === null) return false;
  const source = event.data.source as unknown as { kind?: unknown; plugin?: unknown };
  return source.kind === "plugin" && source.plugin === "compact";
}

function compactionBrackets(events: readonly SessionEvent[]): CompactionBracket[] {
  const brackets: CompactionBracket[] = [];
  let open: { start: SessionEvent; summary?: SessionEvent; checkpoint?: SessionEvent } | undefined;
  for (const event of events) {
    const type = compactionTypeOf(event);
    if (type === "compaction/start") {
      open = { start: event };
      continue;
    }
    if (open === undefined) continue;
    if (type === "compaction/summary") {
      open.summary = event;
      continue;
    }
    if (type === "compaction/end") {
      if (open.checkpoint !== undefined) {
        brackets.push({
          start: open.start,
          ...(open.summary === undefined ? {} : { summary: open.summary }),
          checkpoint: open.checkpoint,
          end: event,
        });
      }
      open = undefined;
      continue;
    }
    if (isCompactionCheckpoint(event)) open.checkpoint = event;
  }
  return brackets;
}

// 截断丢掉、但仍在重放目标之前的完整压缩事务。
export function droppedCompactions(
  events: readonly SessionEvent[],
  keepFrom: number,
  targetSeq: number,
): CompactionBracket[] {
  return compactionBrackets(events).filter(
    (bracket) => bracket.start.seq >= keepFrom && bracket.end.seq < targetSeq,
  );
}

function replacementRange(event: SessionEvent): { start: number; end: number } | undefined {
  const op = (
    event as unknown as { surfaceOp?: { op?: unknown; startSeq?: unknown; endSeq?: unknown } }
  ).surfaceOp;
  if (op?.op !== "replace") return undefined;
  if (typeof op.startSeq !== "number" || typeof op.endSeq !== "number") return undefined;
  return { start: op.startSeq, end: op.endSeq };
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

// 把截断丢掉的压缩重排到 base 起的连续 seq：standalone 形态（不属于任何 turn，与手动 /compact 一致），
// 摘要替换引用的 seq 同步重编号（保留前缀内的 seq 不变），metering 事件与替换消息保持相邻。
export function restoreCompactions(
  brackets: readonly CompactionBracket[],
  keepFrom: number,
  base: number,
): SessionEvent[] {
  const moved = new Map<number, number>();
  const resolve = (seq: number): number | undefined => (seq < keepFrom ? seq : moved.get(seq));
  const resolveAll = (seqs: readonly number[]): number[] | undefined => {
    const resolved: number[] = [];
    for (const seq of seqs) {
      const next = resolve(seq);
      if (next === undefined) return undefined;
      resolved.push(next);
    }
    return resolved;
  };

  const restored: SessionEvent[] = [];
  for (const bracket of brackets) {
    const range = replacementRange(bracket.checkpoint);
    const shadowedSeqs = resolveAll(
      numberList((bracket.summary?.data as { shadowedSeqs?: unknown } | undefined)?.shadowedSeqs),
    );
    const start = range === undefined ? undefined : resolve(range.start);
    const end = range === undefined ? undefined : resolve(range.end);
    // 引用了被丢弃事件的压缩无法重建替换范围，只能一并丢弃
    if (start === undefined || end === undefined || shadowedSeqs === undefined) continue;

    const at = base + restored.length;
    const summary = bracket.summary;
    const checkpointSeq = at + (summary === undefined ? 1 : 2);
    moved.set(bracket.start.seq, at);
    if (summary !== undefined) moved.set(summary.seq, at + 1);
    moved.set(bracket.checkpoint.seq, checkpointSeq);
    moved.set(bracket.end.seq, checkpointSeq + 1);

    // 引用自身事务的事件按新位置重算：开标记、metering 事件、替换范围内的 surface 节点
    const sources = [at, ...(summary === undefined ? [] : [at + 1]), ...shadowedSeqs];
    restored.push(
      standaloneCompaction(bracket.start, at),
      ...(summary === undefined
        ? []
        : [meteringShadowPrice(summary, at + 1, { start, end }, shadowedSeqs)]),
      replacementCheckpoint(bracket.checkpoint, checkpointSeq, { start, end }, sources),
      standaloneCompaction(bracket.end, checkpointSeq + 1),
    );
  }
  return restored;
}

function standaloneCompaction(event: SessionEvent, seq: number): SessionEvent {
  return {
    ...event,
    seq: SessionSeq(seq),
    data: { ...event.data, turn: null },
  } as unknown as SessionEvent;
}

function meteringShadowPrice(
  event: SessionEvent,
  seq: number,
  range: { start: number; end: number },
  shadowedSeqs: readonly number[],
): SessionEvent {
  return {
    ...event,
    seq: SessionSeq(seq),
    data: {
      ...event.data,
      shadowedRange: { start: range.start, end: range.end },
      shadowedSeqs: [...shadowedSeqs],
    },
  } as unknown as SessionEvent;
}

function replacementCheckpoint(
  event: SessionEvent,
  seq: number,
  range: { start: number; end: number },
  sources: readonly number[],
): SessionEvent {
  return {
    ...event,
    seq: SessionSeq(seq),
    surfaceOp: { op: "replace", startSeq: range.start, endSeq: range.end },
    sourceEventSeqs: [...sources],
  } as unknown as SessionEvent;
}
