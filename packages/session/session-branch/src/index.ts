import type { Context } from "@deepseek-ai/cordis";
import { SessionBranch } from "./branch.ts";

export { SessionBranch } from "./branch.ts";
export type { SessionBranchProvider, BranchAnchorMode } from "./provider.ts";
export { buildTimeline } from "./timeline.ts";
export type { OwnEventsReader } from "./timeline.ts";
export { balanceRewindPrefix } from "./balance.ts";
export * from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionBranch: SessionBranch;
  }
}

export function apply(_ctx: Context): void {
  // 契约层不发布服务：ctx.sessionBranch 由实现 provider 的后端插件注册。
  // 保留 apply 仅为 cordis 插件装配兼容，不注入任何服务。
}
