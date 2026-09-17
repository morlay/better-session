import type { Context } from "@deepseek-ai/cordis";
import type {
  ConversationNodeDefinition,
  ConversationPreviousContext,
} from "@morlay/dsh-client-ui-conversation/client";

interface InboxIdentity {
  readonly id: string;
}

interface InboxSplice {
  readonly start: number;
  readonly removedCount?: number;
  readonly inserted: readonly InboxIdentity[];
  readonly outcome?: "canceled";
}

interface PendingSnapshot {
  readonly kind: "snapshot";
  readonly ids: readonly string[];
}

interface PendingSplice {
  readonly kind: "splice";
  readonly previous: PendingState;
  readonly start: number;
  readonly removedCount: number;
  readonly inserted: readonly string[];
}

type PendingState = PendingSnapshot | PendingSplice;

export interface InboxState {
  readonly pending: PendingState;

  readonly currentClaimed: ReadonlySet<string>;
}

const EMPTY_PENDING: PendingState = { kind: "snapshot", ids: [] };
const EMPTY_CURRENT_CLAIMED: ReadonlySet<string> = new Set();

function materializePending(state: PendingState): string[] {
  const splices: PendingSplice[] = [];
  let current = state;
  while (current.kind === "splice") {
    splices.push(current);
    current = current.previous;
  }
  const pending = [...current.ids];
  for (const splice of splices.reverse()) {
    pending.splice(splice.start, splice.removedCount, ...splice.inserted);
  }
  return pending;
}

function withoutInserted(
  claimed: ReadonlySet<string>,
  inserted: readonly string[],
): ReadonlySet<string> {
  let next: Set<string> | undefined;
  for (const id of inserted) {
    if (!claimed.has(id)) continue;
    next ??= new Set(claimed);
    next.delete(id);
  }
  return next ?? claimed;
}

function applySplice(
  previous: ConversationPreviousContext<InboxState> | undefined,
  splice: InboxSplice,
): InboxState {
  const priorPending = previous?.state.pending ?? EMPTY_PENDING;
  const inserted = splice.inserted.map((identity) => identity.id);
  const removedCount = splice.removedCount ?? 0;
  if (removedCount > 0 && splice.outcome !== "canceled") {
    const pending = materializePending(priorPending);
    const removed = pending.splice(splice.start, removedCount, ...inserted);
    return {
      pending: { kind: "snapshot", ids: pending },
      currentClaimed: new Set(removed),
    };
  }
  const currentClaimed = withoutInserted(
    previous?.state.currentClaimed ?? EMPTY_CURRENT_CLAIMED,
    inserted,
  );
  return {
    pending: {
      kind: "splice",
      previous: priorPending,
      start: splice.start,
      removedCount,
      inserted,
    },
    currentClaimed,
  };
}

const NEXT_STEP_INBOX_KIND = "inbox-next-step";

export const nextStepInboxDefinition: ConversationNodeDefinition<InboxState> = {
  kind: NEXT_STEP_INBOX_KIND,
  match: (event) => {
    if (event.type === "agent/inbox/spliced" && event.data.target === "next-step") {
      return { id: String(event.seq), role: "start" };
    }
    return null;
  },
  start: (_context, match, reader) => {
    if (match.event.type !== "agent/inbox/spliced") {
      throw new Error("inbox-next-step start requires agent/inbox/spliced");
    }
    return applySplice(reader.previous<InboxState>(NEXT_STEP_INBOX_KIND), match.event.data);
  },
  update: (context) => context.state,
  publication: () => "none",
};

export function registerInboxConversationNodes(ctx: Context): void {
  ctx.uiConversation.events.register(nextStepInboxDefinition);
}
