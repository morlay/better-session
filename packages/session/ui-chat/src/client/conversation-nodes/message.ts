import type { Context } from "@deepseek-ai/cordis";
import type {
  ContextMessageNode,
  ConversationNodeDefinition,
  SteeringMessageNode,
  UserMessageNode,
} from "@morlay/dsh-client-ui-conversation/client";
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { InboxState } from "./inbox.ts";
import { chatNode } from "./common.ts";
import { contextForm, contextProducer } from "./event-projection.ts";

interface ReferencedUserMessageNode extends UserMessageNode {
  readonly referenceLabels?: readonly string[];

  readonly skillNames?: readonly string[];
}

interface ReferencedSteeringMessageNode extends SteeringMessageNode {
  readonly referenceLabels?: readonly string[];

  readonly skillNames?: readonly string[];
}

type MessageNode = ReferencedUserMessageNode | ReferencedSteeringMessageNode | ContextMessageNode;

declare module "../contract/chat-nodes.ts" {
  interface ChatNodeDataMap {
    user: ReferencedUserMessageNode;

    steering: ReferencedSteeringMessageNode;

    context: ContextMessageNode;
  }
}

function isCompactionCheckpoint(
  event: Parameters<ConversationNodeDefinition["match"]>[0],
): boolean {
  if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return false;
  const source = event.data.source;
  return source.kind === "plugin" && source.plugin === "compact";
}

export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: "input-message",
  target: "chat",
  match: (event) =>
    event.type === "user/message" && isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event)
      ? { id: String(event.data.id), role: "start" }
      : null,
  start: (_context, match, reader) => {
    if (match.event.type !== "user/message")
      throw new Error("input-message start requires user/message");
    const event = match.event;
    if (event.data.source.kind !== "user") {
      return {
        kind: "context",
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        producer: contextProducer(event.data.source),
        form: contextForm(event.data.source),
      };
    }
    const claimed =
      reader
        .previous<InboxState>("inbox-next-step")
        ?.state.currentClaimed.has(String(event.data.id)) === true;
    return claimed
      ? {
          kind: "steering",
          messageId: event.data.id,
          seq: event.seq,
          time: event.time,
          content: event.data.content,
          source: event.data.source,
        }
      : {
          kind: "user",
          seq: event.seq,
          time: event.time,
          content: event.data.content,
          source: event.data.source,
        };
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null;
    return chatNode(context, context.state.kind, context.state.seq, context.state);
  },
};

export function registerMessageConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(messageDefinition);
}
