import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEventMap } from "@deepseek-ai/dsh-session";

// 编译期诊断：module augmentation 后 `keyof SessionEventMap` 可见，但
// dsh-session 内已解析的 `SessionEventType` 别名不会重求值——因此
// `SessionEvent<"session-branch/version">` 泛型不可用，守卫/消费走结构化。
type _BranchKeyCheck = "session-branch/version" extends keyof SessionEventMap ? true : false;
export const _branchKeyVisible: _BranchKeyCheck = true as const;

export const SESSION_BRANCH_VERSION_SCHEMA = 1;

export type CascadePolicy = "truncate" | "preserve";

export type VersionOperation = "edit" | "reroll" | "retry" | "fork" | "rewind";

export type EditableBlockKind = "user" | "assistant.reasoning" | "assistant.response";

export interface SessionBranchEffect {
  id: string;
  operation: VersionOperation;
  cascade: CascadePolicy;

  targetTurn: number;

  targetEventSeq: number;
  targetBlockIndex?: number;
  blockKind?: EditableBlockKind;

  before?: string;

  after?: string;
}

export interface SessionBranchInverse {
  kind: "restore-version";
  sessionId: SessionId;
}

export interface SessionBranchVersionEvent {
  schemaVersion: typeof SESSION_BRANCH_VERSION_SCHEMA;
  effect: SessionBranchEffect;
  inverse: SessionBranchInverse;
}

declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "session-branch/version": SessionBranchVersionEvent;
  }
}

export interface BranchBoundary {
  seq: number;

  events: readonly SessionEvent[];
}

export interface BranchForkMeta {
  cwd?: string;
  createdAt?: number;
  agentPreset?: string;
  origin?: "subagent";
  delegationDepth?: number;
}

export interface ForkFromOptions {
  atSeq?: number;

  anchorMode?: import("./provider.ts").BranchAnchorMode;

  seedSuffix?: readonly SessionEvent[];

  childSessionId?: SessionId;

  meta?: BranchForkMeta;
}

export interface BranchVersionNode {
  sessionId: SessionId;
  parentSessionId?: SessionId;

  seedLength: number;
  createdAt: number;

  effect?: SessionBranchEffect;

  inverseSessionId?: SessionId;
}

export interface BranchTimeline {
  root: BranchVersionNode;
  nodes: BranchVersionNode[];
}

export type SessionBranchErrorCode =
  | "SESSION_NOT_FOUND"
  | "INVALID_BOUNDARY"
  | "OPEN_TURN"
  | "FORK_UNAVAILABLE"
  | "REWIND_CONFLICT";

export class SessionBranchError extends Error {
  readonly code: SessionBranchErrorCode;
  constructor(message: string, code: SessionBranchErrorCode) {
    super(message);
    this.name = "SessionBranchError";
    this.code = code;
  }
}

export interface SessionBranchVersionEventEnvelope {
  type: "session-branch/version";
  seq: number;
  time: number;
  ignorable?: true;
  data: SessionBranchVersionEvent;
}

export function isSessionBranchVersionEvent(
  event: SessionEvent | { type: string; data: unknown },
): event is SessionBranchVersionEventEnvelope {
  return (
    event.type === "session-branch/version" &&
    (event.data as { schemaVersion?: unknown }).schemaVersion === SESSION_BRANCH_VERSION_SCHEMA
  );
}
