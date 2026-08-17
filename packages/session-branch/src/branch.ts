/**
 * 分支式会话编辑的高层服务（`ctx.sessionBranch`）：面向数据层
 * {@link SessionBranchProvider} 的抽象服务面。后端（如
 * `@morlay/session-rdb`）继承本类并提供 provider 实现，
 * 编排层（`@morlay/ui-conversation-message-actions`）只依赖本服务。
 *
 * @module @morlay/session-branch
 */

import { Service } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import type { BranchBoundary, BranchTimeline, ForkFromOptions } from "./types.ts";

/**
 * 抽象服务：组合分支数据层（rewind / forkFrom）与版本树投影，暴露统一的
 * 服务面。`timeline` 的共享实现见 {@link buildTimeline}（后端组合
 * `sessionPersistence` 快照 + 自有后缀读取后调用）。
 */
export abstract class SessionBranch extends Service {
  constructor(ctx: import("@deepseek-ai/cordis").Context) {
    super(ctx, "sessionBranch");
  }

  /** 定位 `atSeq` 锚定的闭合边界并返回其前缀（含边界事件）。 */
  abstract readBranchPrefix(
    id: SessionId,
    atSeq?: number,
    mode?: import("./provider.ts").BranchAnchorMode,
    signal?: AbortSignal,
  ): Promise<BranchBoundary>;

  /** 从持久化源派生新会话（纯 append；返回派生会话 id）。 */
  abstract forkFrom(
    sourceId: SessionId,
    options?: ForkFromOptions,
    signal?: AbortSignal,
  ): Promise<SessionId>;

  /** 显式授权的截断式回退；返回截断后的快照（header + revision）。 */
  abstract rewind(
    id: SessionId,
    toBoundary: number,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot>;

  /** 完整版本树投影（根 + 全部已知节点）。 */
  abstract timeline(sessionId: SessionId, signal?: AbortSignal): Promise<BranchTimeline>;

  /**
   * 同步 live 会话的 coordinator 内存 cursor 到其 log 长度。就地编辑时，
   * 编排层会把 ignorable 的版本效果直接 push 进 live log（不发布
   * `session/event`，不进 write-behind 缓冲），导致 coordinator 的 cursor
   * 落后于 log——后续 manualTurn 的 append（seq 从 log 续接）会在 flush 的
   * seq 校验上错位。默认无操作；rdb 后端覆写（访问 coordinator 的 states）。
   */
  syncLiveCursor(_sessionId: SessionId): void {
    // 默认无操作。
  }
}
