import { Service } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import type { BranchBoundary, BranchTimeline, ForkFromOptions } from "./types.ts";

export abstract class SessionBranch extends Service {
  constructor(ctx: import("@deepseek-ai/cordis").Context) {
    super(ctx, "sessionBranch");
  }

  abstract readBranchPrefix(
    id: SessionId,
    atSeq?: number,
    mode?: import("./provider.ts").BranchAnchorMode,
    signal?: AbortSignal,
  ): Promise<BranchBoundary>;

  abstract forkFrom(
    sourceId: SessionId,
    options?: ForkFromOptions,
    signal?: AbortSignal,
  ): Promise<SessionId>;

  abstract rewind(
    id: SessionId,
    toBoundary: number,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot>;

  abstract timeline(sessionId: SessionId, signal?: AbortSignal): Promise<BranchTimeline>;

  syncLiveCursor(_sessionId: SessionId): void {
    // 默认无操作。
  }
}
