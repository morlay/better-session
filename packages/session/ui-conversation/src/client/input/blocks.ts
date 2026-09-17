import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ComposerBlock, ComposerBlocks } from "../contract/composer-blocks.ts";

export class ComposerBlockRegistry implements ComposerBlocks {
  private readonly stores = new Map<SessionId, SnapshotStore<ComposerBlock | undefined>>();

  set(sessionId: SessionId, block: ComposerBlock | undefined): void {
    const store = this.storeFor(sessionId);
    const current = store.getSnapshot();
    if (current?.reason === block?.reason) return;
    store.set(block);
  }

  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined> {
    const existing = this.stores.get(sessionId);
    if (existing !== undefined) return existing;
    const created = createSnapshotStore<ComposerBlock | undefined>(undefined);
    this.stores.set(sessionId, created);
    return created;
  }

  forget(sessionId: SessionId): void {
    this.stores.delete(sessionId);
  }
}
