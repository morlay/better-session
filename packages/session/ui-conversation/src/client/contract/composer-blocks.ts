import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

export interface ComposerBlock {
  readonly reason: string;
}

export interface ComposerBlocks {
  set(sessionId: SessionId, block: ComposerBlock | undefined): void;

  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined>;

  forget(sessionId: SessionId): void;
}
