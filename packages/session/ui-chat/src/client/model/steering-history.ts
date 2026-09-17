import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import type { InboxTarget } from "@deepseek-ai/dsh-agent/types";

interface PendingIdentity {
  readonly id: string;
}

interface InboxSplice {
  readonly target: InboxTarget;
  readonly start: number;
  readonly removedCount?: number;
  readonly inserted: readonly PendingIdentity[];
  readonly outcome?: "canceled";
}

export class SteeringHistory {
  private readonly inbox: Record<InboxTarget, PendingIdentity[]> = {
    "next-turn": [],
    "next-step": [],
  };

  private readonly claimedNextStep = new Set<string>();

  reset(): void {
    this.inbox["next-turn"] = [];
    this.inbox["next-step"] = [];
    this.claimedNextStep.clear();
  }

  apply(event: SessionEvent): boolean {
    if (event.type === "agent/inbox/spliced") {
      this.applySplice(event.data);
      return false;
    }
    if (event.type !== "user/message") return false;
    const id = event.data.id;
    if (!this.claimedNextStep.delete(id)) return false;
    return event.data.source.kind === "user";
  }

  private applySplice({ target, start, removedCount = 0, inserted, outcome }: InboxSplice): void {
    const removed = this.inbox[target].splice(start, removedCount, ...inserted);
    for (const identity of inserted) this.claimedNextStep.delete(identity.id);
    if (target !== "next-step" || outcome === "canceled") return;
    for (const identity of removed) this.claimedNextStep.add(identity.id);
  }
}
