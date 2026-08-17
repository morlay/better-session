/**
 * 编排层操作类型：把 `rewind / retry / fork` 表达为面向用户的命令。
 * 参考 `dsh-message-edit` 的产品语义（edit / reroll / retry + 级联策略），
 * 但操作对象是 `@morlay/session-branch` 的 provider 抽象而非具体后端。
 *
 * @module @morlay/ui-conversation-message-actions/types
 */

import type { SessionId } from "@deepseek-ai/dsh-session";
import type { BranchTimeline, CascadePolicy } from "@morlay/session-branch";

/** 编辑一个已落定文本块（用户 / 助手 reasoning / 助手 response）并从其轮次边界分支。 */
export interface EditOperation {
  action: "edit";
  sessionId: SessionId;
  /** 目标事件 seq（`user/message` 或 `assistant/message`）。 */
  eventSeq: number;
  /** 目标内容块索引（text / reasoning）。 */
  blockIndex: number;
  /** 替换后的文本。 */
  text: string;
  cascade: CascadePolicy;
}

/** 重生成最后一条已落定助手回复（使用原用户输入）。 */
export interface RerollOperation {
  action: "reroll";
  sessionId: SessionId;
}

/** 重试任意历史回合（从目标轮之前分支，重放其用户输入）。 */
export interface RetryOperation {
  action: "retry";
  sessionId: SessionId;
  turn: number;
  cascade: CascadePolicy;
}

/** 截断式回退：原会话回退到 `toBoundary`（闭合 `turn/end`）。 */
export interface RewindOperation {
  action: "rewind";
  sessionId: SessionId;
  toBoundary: number;
}

/** 派生式分支：从 `atSeq` 锚定的闭合边界派生新会话。 */
export interface ForkOperation {
  action: "fork";
  sessionId: SessionId;
  atSeq?: number;
  childSessionId?: SessionId;
}

/** 编排层接受的操作判别联合。 */
export type SessionEditorOperation =
  | EditOperation
  | RerollOperation
  | RetryOperation
  | RewindOperation
  | ForkOperation;

/** 操作结果：分支式操作返回新版本 id；`rewind` 返回原会话 id。 */
export interface SessionEditorResult {
  sessionId: SessionId;
  /** 排队重新执行的用户输入轮数（无 agent 驱动时为 0）。 */
  queuedTurns: number;
  /**
   * 操作后会话是否仍有 live owner（agent 驻留 / driveAgent 已恢复）。
   * 客户端据此决定是否需要重载页面：live 会话的事件流会增量同步
   * conversation（不闪屏）；cold 会话无事件流，需重载以反映修剪。
   */
  live?: boolean;
}

/** Timeline 响应形状（透传 {@link BranchTimeline}）。 */
export type SessionEditorTimeline = BranchTimeline;

/** 可编辑消息块（编辑面枚举；来自闭合轮次扫描）。 */
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
