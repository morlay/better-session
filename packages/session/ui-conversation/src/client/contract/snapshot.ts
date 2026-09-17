import type { SessionSnapshot } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ConversationViewSnapshotStore } from "./conversation.ts";

export interface ConversationSnapshot {
  readonly views: ConversationViewSnapshotStore;
  readonly activeTargets: ReadonlySet<string>;
}

export const EMPTY_CONVERSATION_SNAPSHOT: ConversationSnapshot = {
  views: { get: () => undefined },
  activeTargets: new Set(),
};

export type ConversationPhase = "blank" | "engaging" | "active";

export function conversationPhase(
  session: SessionSnapshot,
  conversation: ConversationSnapshot,
): ConversationPhase {
  const active =
    conversation.activeTargets.size > 0 ||
    (!session.blank && !session.awaitingFirstTurn) ||
    session.running;
  return active ? "active" : session.promptAttempted ? "engaging" : "blank";
}
