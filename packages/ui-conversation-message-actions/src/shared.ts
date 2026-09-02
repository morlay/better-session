import type { SessionId } from "@deepseek-ai/dsh-session";
import type { BranchTimeline, CascadePolicy } from "@morlay/session-branch";
import type { VersionOperation } from "@morlay/session-branch";

export const SESSION_EDITOR_PATH = "/session-editor";

export type { VersionOperation } from "@morlay/session-branch";

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

export interface SessionEditorOperationResult {
  sessionId: SessionId;
  queuedTurns: number;

  live?: boolean;
}

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

export interface VersionSummary {
  sessionId: string;
  parentSessionId?: string;
  effectId?: string;
  inverseSessionId?: string;
  createdAt: number;
  depth: number;
  current: boolean;
  onCurrentEffectPath: boolean;
  operation?: VersionOperation;
  cascade?: CascadePolicy;
  targetTurn?: number;
  blockKind?: EditableMessageBlock["kind"];
  before?: string;
  after?: string;
}

export interface SessionEditorTimeline {
  sessionId: string;
  messages: EditableMessageBlock[];
  retryableTurns: RetryableTurn[];
  versions: VersionSummary[];

  undoStack: string[];

  redoSessionIds: string[];
}

export function toTimelinePayload(
  sessionId: SessionId,
  timeline: BranchTimeline,
  messages: EditableMessageBlock[],
  retryableTurns: RetryableTurn[],
): SessionEditorTimeline {
  const currentPath = new Set<string>();
  for (const node of timeline.nodes) currentPath.add(String(node.sessionId));
  const versions: VersionSummary[] = timeline.nodes.map((node) => ({
    sessionId: String(node.sessionId),
    ...(node.parentSessionId === undefined
      ? {}
      : { parentSessionId: String(node.parentSessionId) }),
    ...(node.effect === undefined
      ? {}
      : {
          effectId: node.effect.id,
          inverseSessionId: String(node.inverseSessionId),
          operation: node.effect.operation,
          cascade: node.effect.cascade,
          targetTurn: node.effect.targetTurn,
          ...(node.effect.blockKind === undefined ? {} : { blockKind: node.effect.blockKind }),
          ...(node.effect.before === undefined ? {} : { before: node.effect.before }),
          ...(node.effect.after === undefined ? {} : { after: node.effect.after }),
        }),
    createdAt: node.createdAt,
    depth: depthOf(timeline, node.sessionId),
    current: String(node.sessionId) === String(sessionId),
    onCurrentEffectPath: currentPath.has(String(node.sessionId)),
  }));
  const versionsById = new Map(versions.map((version) => [version.sessionId, version]));
  const undoStack: string[] = [];
  let cursor = versionsById.get(String(sessionId));
  while (cursor?.inverseSessionId !== undefined) {
    if (undoStack.includes(cursor.inverseSessionId)) break;
    undoStack.push(cursor.inverseSessionId);
    cursor = versionsById.get(cursor.inverseSessionId);
  }
  const redoSessionIds = versions
    .filter((version) => version.inverseSessionId === String(sessionId))
    .map((version) => version.sessionId);
  return {
    sessionId: String(sessionId),
    messages,
    retryableTurns,
    versions,
    undoStack,
    redoSessionIds,
  };
}

function depthOf(
  timeline: BranchTimeline,
  sessionId: import("@deepseek-ai/dsh-session").SessionId,
): number {
  const byId = new Map(timeline.nodes.map((node) => [String(node.sessionId), node]));
  let depth = 0;
  let cursor = byId.get(String(sessionId));
  const seen = new Set<string>();
  while (cursor?.parentSessionId !== undefined && !seen.has(String(cursor.sessionId))) {
    seen.add(String(cursor.sessionId));
    depth += 1;
    cursor = byId.get(String(cursor.parentSessionId));
  }
  return depth;
}
