import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm";
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
  /** 轮内全部 user/message（agent 运行中 followup 追加的输入也计入）。 */
  users: SessionEvent<"user/message">[];
  assistants: SessionEvent<"assistant/message">[];
}

export interface OperationPlan {
  anchorSeq: number;

  rewindBoundary?: number;
  version: SessionBranchVersionEvent;

  manualTurn?: { turn: number; user: UserMessage; assistant: AssistantMessage };

  queuedUsers: UserMessage[];
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
      // 轮内全部 user/message 都记录：agent 运行中 followup 追加的输入
      // （第二条及之后）也是已落定文本，可编辑。
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
  // 未闭合轮次（无 turn/end）也保留：user 消息已落定，编辑时 rewind 到该
  // 消息（exclusive drop）重放即可。
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
    // 未闭合轮次的助手消息是流式 partial，不可编辑。
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
    // 未闭合轮次无已落定回复可重生成，不可重试。
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

export function downstreamUsers(turns: readonly ClosedTurn[], start: number): UserMessage[] {
  return turns
    .slice(start)
    .flatMap((turn): UserMessage[] => turn.users.map((user) => cloneUser(user.data)));
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
    // 轮内后续 user/message（agent 运行中 followup 追加的输入）是已落定
    // 输入：rewind 会 drop 它们，重放时保留（truncate 只截断回复，不丢输入）。
    const userIndex = turn.users.findIndex((candidate) => candidate.seq === event.seq);
    const sameTurnFollowups = turn.users.slice(userIndex + 1).map((user) => cloneUser(user.data));
    const later = operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : [];
    return {
      anchorSeq: turn.startSeq,
      // 轮首 user 编辑（闭合轮）：整轮截断重放（rewind 到前一轮 turn/end）；
      // 其余情况（未闭合轮、轮内 followup）：rewind 到该消息本身
      // （exclusive drop），保留轮内已落定的前置输入与回复。
      ...(turn.closed && userIndex === 0 ? {} : { rewindBoundary: event.seq }),
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
    };
  }

  // 未闭合轮次的助手消息是流式 partial，无最终内容可编辑。
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
  };
}

export function rerollPlan(operation: RerollOperation, turns: readonly ClosedTurn[]): OperationPlan {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    // 未闭合轮次无已落定的助手回复可重生成。
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
    };
  }
  throw new SessionBranchError("当前会话没有可重生成的已落定助手回复。", "INVALID_BOUNDARY");
}
