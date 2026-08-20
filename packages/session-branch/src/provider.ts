/**
 * 数据层分支原语：在 append-only 事件日志之上提供 rewind（截断式回退）与
 * forkFrom（派生式分支）。具体持久化后端（RDB / JSONL / 内存）实现本接口，
 * 编排层（`SessionBranch` 服务 / `@morlay/ui-conversation-message-actions`）面向它编程。
 *
 * 与 `@deepseek-ai/dsh-session-persistence` 的 `PersistenceBackend` 的关系：
 * 本接口是**额外**的 provider 抽象——`PersistenceBackend` 覆盖「持久读写 +
 * 崩溃修复」的 append-only 面，本接口覆盖「显式回退 + 闭合边界派生」的
 * 分支面。一个后端可以同时实现两者（如 `@morlay/session-rdb`），
 * 形成闭环。
 *
 * @module @morlay/session-branch/provider
 */

import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import type { BranchBoundary, ForkFromOptions } from "./types.ts";

/** 边界锚定模式。 */
export type BranchAnchorMode = "after" | "before";

/**
 * 分支数据层的后端契约。实现方必须保证：
 *
 * - `readBranchPrefix`：只读、不提交修复、不发布；返回的边界必是闭合
 *   `turn/end`，且 `events` 与其 seq 连续（与持久化读取语义一致）。
 * - `forkFrom`：纯 append——新会话（新 id / `parentSession` / `seedLength`），
 *   不触碰源会话；seed = 边界前缀 + `seedSuffix`。
 * - `rewind`：唯一改写事件 log 的服务面操作；**独占条件**（无 live owner、
 *   无 in-flight append、无 prepared reservation）由实现方校验；事务整体
 *   提交或回滚（Abort 不部分截断）；成功后 revision 变化，后续 append 从
 *   新尾部继续。
 */
export interface SessionBranchProvider {
  /** 后端名（rewind 冲突诊断用）。 */
  readonly name: string;

  /**
   * 定位 `atSeq` 锚定的闭合边界并返回其前缀（含边界事件）。
   *
   * - `mode: "after"`（默认）：边界 = **≥ atSeq** 的第一个 `turn/end`——
   *   「从目标轮结束处派生」（proposal 的 forkFrom 语义，包含目标轮）。
   * - `mode: "before"`：边界 = **< atSeq** 的最后一个 `turn/end`——
   *   「从目标轮之前分支」（分支式编辑/重掷/重试语义，排除目标轮）。
   *
   * 省略 `atSeq` 或越过日志末尾 → 最后一个闭合轮次；`atSeq` 锚定所在轮
   * 未闭合（after 模式）→ 拒绝（`OPEN_TURN`）；会话不存在 → 拒绝
   * （`SESSION_NOT_FOUND`）。
   * @param id - 持久化源会话。
   * @param atSeq - 锚定 seq（inclusive）；省略取最后闭合轮次。
   * @param mode - 锚定模式（见上）。
   * @param signal - 读取消。
   */
  readBranchPrefix(
    id: SessionId,
    atSeq?: number,
    mode?: BranchAnchorMode,
    signal?: AbortSignal,
  ): Promise<BranchBoundary>;

  /**
   * 从持久化源派生新会话：seed = 边界前缀 + `options.seedSuffix`，meta 记录
   * `parentSession` / `seedLength`。纯 append（派生不修改源），派生会话在
   * 返回前已 durable（沿用 lazily-materialized 语义——空 seed 派生仍注册
   * header，首个 append 才落盘）。
   * @param sourceId - 持久化源会话。
   * @param options - 边界锚定、seed 后缀、派生 id 与 meta。
   * @param signal - 派生过程取消。
   * @returns 派生的会话 id（`options.childSessionId` 或后端 mint）。
   */
  forkFrom(
    sourceId: SessionId,
    options?: ForkFromOptions,
    signal?: AbortSignal,
  ): Promise<SessionId>;

  /**
   * 显式授权的截断式回退：截断事件 log 至 `toBoundary`。`toBoundary` 必须是
   * 非负整数、事件存在、且为 `turn/end` 或 `user/message`；否则拒绝
   * （`INVALID_BOUNDARY` / `SESSION_NOT_FOUND`）。
   *
   * 边界语义按类型区分：
   * - `turn/end`：**保留到该事件**（inclusive）——轮次完整闭合，后续轮次
   *   被截断；
   * - `user/message`：**drop 该消息及其后**（exclusive）——编辑重放语义：
   *   该消息会被编辑后的版本替换，因此边界消息本身不保留。
   *
   * 返回截断后的快照（header + revision）。
   * @param id - 持久化会话。
   * @param toBoundary - 截断点 seq（`turn/end` inclusive / `user/message` exclusive）。
   * @param signal - 中断时事务整体回滚（不部分截断）。
   */
  rewind(
    id: SessionId,
    toBoundary: number,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot>;
}
