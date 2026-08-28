/**
 * 分支式会话编辑的共享类型：版本效果事件（`session-branch/version`）、
 * 闭合边界定位、派生元数据与版本树投影。
 *
 * 设计对齐 `@deepseek-ai/dsh-session` 的 merge-extensible `SessionEventMap`：
 * 版本事件是插件合并进事件映射的**持久**事件（占 seq、入 canonical log），
 * `parentSession` + `seedLength`（durable lineage）区分「继承」与「自有」。
 *
 * @module @morlay/session-branch/types
 */

import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEventMap } from "@deepseek-ai/dsh-session";

// 编译期诊断：module augmentation 后 `keyof SessionEventMap` 可见，但 dsh-session
// 内已解析的 `SessionEventType` 别名（= keyof SessionEventMap）不会重求值——
// 因此 `SessionEvent<"session-branch/version">` 泛型不可用，守卫/消费走结构化。
type _BranchKeyCheck = "session-branch/version" extends keyof SessionEventMap
  ? true
  : false;
export const _branchKeyVisible: _BranchKeyCheck = true as const;

/** 版本效果事件的数据结构版本（独立于 session 的 SESSION_FORMAT_VERSION）。 */
export const SESSION_BRANCH_VERSION_SCHEMA = 1;

/** 下游历史策略：目标轮次之后旧后续的去留。 */
export type CascadePolicy = "truncate" | "preserve";

/** 一个版本效果代表的用户可见操作。 */
export type VersionOperation = "edit" | "reroll" | "retry" | "fork" | "rewind";

/** 可编辑的模型可见块分类。 */
export type EditableBlockKind =
  "user" | "assistant.reasoning" | "assistant.response";

/** 一个版本效果的「正向」半边：记录做了什么、改了什么。 */
export interface SessionBranchEffect {
  /** 效果 id（全局唯一，跨版本树去重用）。 */
  id: string;
  operation: VersionOperation;
  cascade: CascadePolicy;
  /** 被操作的目标轮次（0 基）。 */
  targetTurn: number;
  /** 被操作的目标事件 seq（turn/start 或 user/message 等）。 */
  targetEventSeq: number;
  targetBlockIndex?: number;
  blockKind?: EditableBlockKind;
  /** 编辑前的文本（编辑类操作）。 */
  before?: string;
  /** 编辑后的文本（编辑类操作）。 */
  after?: string;
}

/** 一个版本效果的「逆向」半边：恢复目标（父版本会话）。 */
export interface SessionBranchInverse {
  kind: "restore-version";
  sessionId: SessionId;
}

/**
 * 每个分支版本在自己的非继承后缀中包含的效果对。父版本链自动导出组合逆；
 * 恢复不是删除事件，而是沿逆链切换到仍然存在的版本。
 *
 * 事件信封必须携带 `ignorable: true`：`session-branch/version` 是 branch 层
 * 的 lineage 事实，上游核心不认识它——`ignorable` 标记让不认识它的读者
 * （core / 非 branch 后端）安全跳过而不拒绝整条 log。branch 层后端
 * （如 `@morlay/session-rdb`）特判保留该类型，确保 lineage 落盘。
 */
export interface SessionBranchVersionEvent {
  schemaVersion: typeof SESSION_BRANCH_VERSION_SCHEMA;
  effect: SessionBranchEffect;
  inverse: SessionBranchInverse;
}

declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    /** 分支版本 provenance，由 branch provider / editor 追加到新版本会话。 */
    "session-branch/version": SessionBranchVersionEvent;
  }
}

/** 一次闭合边界的定位结果：边界事件（含）及之前的前缀。 */
export interface BranchBoundary {
  /** 边界事件 seq（含；一个 `turn/end`）。 */
  seq: number;
  /** 边界及之前的前缀事件（`events[seq]` 即边界事件）。 */
  events: readonly SessionEvent[];
}

/** 派生会话的 header 元数据（header 是「创建事实」，派生时冻结）。 */
export interface BranchForkMeta {
  cwd?: string;
  createdAt?: number;
  agentPreset?: string;
  origin?: "subagent";
  delegationDepth?: number;
}

/** `forkFrom` 的派生入参。 */
export interface ForkFromOptions {
  /**
   * 锚定 seq：取 ≥ atSeq 的第一个 `turn/end` 为派生边界；省略或越过日志末尾
   * 回退到源会话最后一个闭合轮次；atSeq 所在轮未闭合则拒绝（OPEN_TURN）。
   * 与 {@link BranchAnchorMode} 配合决定派生点取「目标轮之后」还是
   * 「目标轮之前」。
   */
  atSeq?: number;
  /**
   * 锚定模式（默认 `"after"`）。分支式编辑/重掷/重试传 `"before"`——派生点
   * 取目标轮之前的闭合边界（排除目标轮，目标轮由后续 agent 重新驱动）。
   */
  anchorMode?: import("./provider.ts").BranchAnchorMode;
  /**
   * 在边界前缀之后追加的事件（版本效果事件、手工闭合回合等）。这些事件
   * 成为派生会话自己的非继承后缀，`seedLength` 只计边界前缀。
   */
  seedSuffix?: readonly SessionEvent[];
  /** 派生会话 id；省略由后端按自身 id 策略 mint。 */
  childSessionId?: SessionId;
  /** 派生 header 元数据。 */
  meta?: BranchForkMeta;
}

/** 版本树节点投影（值级，供 Timeline / 标题栏消费）。 */
export interface BranchVersionNode {
  sessionId: SessionId;
  parentSessionId?: SessionId;
  /** durable fork 边界：继承前缀长度。 */
  seedLength: number;
  createdAt: number;
  /** 本会话自有的版本效果（非继承）；根节点无。 */
  effect?: SessionBranchEffect;
  /** 恢复目标（= parentSession 时与 inverse 一致）。 */
  inverseSessionId?: SessionId;
}

/** 完整版本树：根 + 全部已知节点（含根）。 */
export interface BranchTimeline {
  root: BranchVersionNode;
  nodes: BranchVersionNode[];
}

/** 分支操作的拒绝码。 */
export type SessionBranchErrorCode =
  | "SESSION_NOT_FOUND"
  | "INVALID_BOUNDARY"
  | "OPEN_TURN"
  | "FORK_UNAVAILABLE"
  | "REWIND_CONFLICT";

/** 分支操作的 typed error。 */
export class SessionBranchError extends Error {
  readonly code: SessionBranchErrorCode;
  constructor(message: string, code: SessionBranchErrorCode) {
    super(message);
    this.name = "SessionBranchError";
    this.code = code;
  }
}

/**
 * 版本效果事件的结构化信封（守卫的返回类型；不依赖 `SessionEvent<T>` 泛型）。
 */
export interface SessionBranchVersionEventEnvelope {
  type: "session-branch/version";
  seq: number;
  time: number;
  ignorable?: true;
  data: SessionBranchVersionEvent;
}

/**
 * 版本效果事件守卫：事件确实是 `session-branch/version` 且结构受支持。
 *
 * 结构化守卫（参数宽化 + 独立返回类型）：augmentation 对 `keyof SessionEventMap`
 * 可见，但对 dsh-session 内 `SessionEventType` 别名的重求值在 workspace+peer
 * 解析下不可靠（`SessionEvent<"session-branch/version">` 泛型约束失败），
 * 因此不依赖该泛型。
 * @param event - 待判定事件。
 * @returns 是当前 schema 的版本效果事件。
 */
export function isSessionBranchVersionEvent(
  event: SessionEvent | { type: string; data: unknown },
): event is SessionBranchVersionEventEnvelope {
  return (
    event.type === "session-branch/version" &&
    (event.data as { schemaVersion?: unknown }).schemaVersion ===
      SESSION_BRANCH_VERSION_SCHEMA
  );
}
