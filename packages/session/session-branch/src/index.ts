import type { Context } from "@deepseek-ai/cordis";
import { SessionBranch } from "./branch.ts";

export { SessionBranch } from "./branch.ts";
export type { SessionBranchProvider, BranchAnchorMode } from "./provider.ts";
export { buildTimeline } from "./timeline.ts";
export type { OwnEventsReader } from "./timeline.ts";
export { balanceRewindPrefix, rewindKeepLength } from "./balance.ts";
export * from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionBranch: SessionBranch;
  }
}

export function apply(_ctx: Context): void {}
