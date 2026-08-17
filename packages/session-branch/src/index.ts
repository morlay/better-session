/**
 * @morlay/session-branch —— 分支式会话编辑的 provider 抽象 + 高层服务。
 *
 * 本包是 better-session monorepo 的**契约层**：定义数据层分支原语
 * {@link SessionBranchProvider}（rewind / forkFrom）、高层服务
 * {@link SessionBranch}（`ctx.sessionBranch`）与共享的版本树投影
 * {@link buildTimeline}。具体持久化后端实现 provider 后，编排层
 * （`@morlay/ui-conversation-message-actions`）即可在不修改上游 `@deepseek-ai/*` 代码的
 * 前提下提供完整的 rewind / retry / fork 功能。
 *
 * @module @morlay/session-branch
 */

import type { Context } from "@deepseek-ai/cordis";
import { SessionBranch } from "./branch.ts";

export { SessionBranch } from "./branch.ts";
export type { SessionBranchProvider, BranchAnchorMode } from "./provider.ts";
export { buildTimeline } from "./timeline.ts";
export type { OwnEventsReader } from "./timeline.ts";
export * from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 分支式会话编辑服务（rewind / forkFrom / timeline）。 */
    sessionBranch: SessionBranch;
  }
}

/** 注册类型（无运行时副作用；服务由具体后端插件发布）。 */
export function apply(_ctx: Context): void {
  // 契约层不发布服务——`ctx.sessionBranch` 由实现 provider 的后端插件
  // （如 @morlay/session-rdb）在启动时注册为 `SessionBranch`
  // 子类实例。此处保留 apply 是为了 cordis 插件装配兼容（类型声明 + 可空
  // 生命周期），不注入任何服务。
}
