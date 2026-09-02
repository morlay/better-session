import type { SessionId } from "@deepseek-ai/dsh-session";
import type { BranchTimeline, CascadePolicy } from "@morlay/session-branch";

export interface EditOperation {
  action: "edit";
  sessionId: SessionId;

  eventSeq: number;

  blockIndex: number;

  text: string;
  cascade: CascadePolicy;
}

export interface RerollOperation {
  action: "reroll";
  sessionId: SessionId;
}

export interface RetryOperation {
  action: "retry";
  sessionId: SessionId;
  turn: number;
  cascade: CascadePolicy;
}

export interface RewindOperation {
  action: "rewind";
  sessionId: SessionId;
  toBoundary: number;
}

export interface ForkOperation {
  action: "fork";
  sessionId: SessionId;
  atSeq?: number;
  childSessionId?: SessionId;
}

export type SessionEditorOperation =
  | EditOperation
  | RerollOperation
  | RetryOperation
  | RewindOperation
  | ForkOperation;

export interface SessionEditorResult {
  sessionId: SessionId;

  queuedTurns: number;

  live?: boolean;
}

export type SessionEditorTimeline = BranchTimeline;

export interface EditableMessageBlock {
  key: string;
  turn: number;
  eventSeq: number;
  blockIndex: number;
  kind: "user" | "assistant.reasoning" | "assistant.response";
  text: string;
  time: number;
}

export interface RetryableTurn {
  turn: number;
  userEventSeq: number;
  preview: string;
  time: number;
}
