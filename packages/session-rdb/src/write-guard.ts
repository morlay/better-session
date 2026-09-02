import type { SessionId } from "@deepseek-ai/dsh-session";

export class WriteGuard {
  private readonly headSeqs = new Map<SessionId, number>();

  confirmHead(id: SessionId, head: number): void {
    this.headSeqs.set(id, head);
  }

  assertNoConcurrentWriter(id: SessionId, storedHead: number): void {
    const known = this.headSeqs.get(id);
    if (known === undefined) {
      if (storedHead !== -1) {
        throw new Error(
          `session "${id}" has a persisted log this instance has not read; another writer may own it — load the session first`,
        );
      }
      return;
    }
    if (known !== storedHead) {
      throw new Error(
        `session "${id}" was modified by another writer (stored head ${storedHead}, this instance last confirmed head ${known}); ` +
          "concurrent writers on one session are not supported",
      );
    }
  }
}
