import type { Context } from "@deepseek-ai/cordis";
import type {
  ConversationNodeDefinition,
  UnknownSurfaceNode,
} from "@morlay/dsh-client-ui-conversation/client";
import { isAppendSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import { chatNode } from "./common.ts";

declare module "../contract/chat-nodes.ts" {
  interface ChatNodeDataMap {
    unknown: UnknownSurfaceNode;
  }
}

export const unknownFallbackDefinition: ConversationNodeDefinition<UnknownSurfaceNode> = {
  kind: "unknown-surface",
  target: "chat",
  match: (event) =>
    event.type !== "assistant/live-chunk" && isAppendSurfaceEvent(event)
      ? { id: String(event.seq), role: "start" }
      : null,
  start: (_context, match) => ({
    kind: "unknown",
    seq: match.event.seq,
    time: match.event.time,
    type: match.event.type,
    data: match.event.data,
  }),
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state === undefined
      ? null
      : chatNode(context, "unknown", context.state.seq, context.state),
};

export function registerUnknownConversationFallback(ctx: Context): void {
  ctx.uiConversation.events.registerFallback(unknownFallbackDefinition);
}
