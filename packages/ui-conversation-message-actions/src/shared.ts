/**
 * Host 与 client 共享的类型与常量：HTTP 路由、操作判别联合、Timeline 响应。
 *
 * @module @morlay/ui-conversation-message-actions/shared
 */

import type { SessionId } from "@deepseek-ai/dsh-session";
import type { BranchTimeline, CascadePolicy } from "@morlay/session-branch";
import type { VersionOperation } from "@morlay/session-branch";

/** 同源 HTTP 端点（host 注册、client fetch）。 */
export const SESSION_EDITOR_PATH = "/session-editor";

export type { VersionOperation } from "@morlay/session-branch";

/** 编辑一个已落定文本块并从其轮次边界分支。 */
export interface EditOperation {
  action: "edit";
  sessionId: SessionId;
  eventSeq: number;
  blockIndex: number;
  text: string;
  cascade: CascadePolicy;
}

/** 重生成最后一条已落定助手回复。 */
export interface RerollOperation {
  action: "reroll";
  sessionId: SessionId;
}

/** 重试任意历史回合。 */
export interface RetryOperation {
  action: "retry";
  sessionId: SessionId;
  turn: number;
  cascade: CascadePolicy;
}

/** 截断式回退：原会话回退到闭合边界。 */
export interface RewindOperation {
  action: "rewind";
  sessionId: SessionId;
  toBoundary: number;
}

/** 派生式分支：从闭合边界派生新会话。 */
export interface ForkOperation {
  action: "fork";
  sessionId: SessionId;
  atSeq?: number;
  childSessionId?: SessionId;
}

/** HTTP 接受的判别联合。 */
export type SessionEditorOperation =
  | EditOperation
  | RerollOperation
  | RetryOperation
  | RewindOperation
  | ForkOperation;

/** 操作响应（分支式返回新版本 id；rewind 返回原 id）。 */
export interface SessionEditorOperationResult {
  sessionId: SessionId;
  queuedTurns: number;
  /** 操作后会话是否仍有 live owner（客户端据此决定是否重载页面）。 */
  live?: boolean;
}

/** 可编辑文本块（编辑面枚举）。 */
export interface EditableMessageBlock {
  key: string;
  turn: number;
  eventSeq: number;
  blockIndex: number;
  kind: "user" | "assistant.reasoning" | "assistant.response";
  text: string;
  time: number;
}

/** 可重试回合（重试面枚举）。 */
export interface RetryableTurn {
  turn: number;
  userEventSeq: number;
  preview: string;
  time: number;
}

/** 版本摘要（Timeline 节点投影，值级）。 */
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

/** GET /session-editor 的完整投影（Timeline + 编辑/重试面）。 */
export interface SessionEditorTimeline {
  sessionId: string;
  messages: EditableMessageBlock[];
  retryableTurns: RetryableTurn[];
  versions: VersionSummary[];
  /** 原子逆链（从当前版本向外，应用顺序）。 */
  undoStack: string[];
  /** 可直接重施加的子版本。 */
  redoSessionIds: string[];
}

/** 把 {@link BranchTimeline} 投影成 client 用的 {@link SessionEditorTimeline}。 */
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

/** 计算节点到根的深度。 */
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
