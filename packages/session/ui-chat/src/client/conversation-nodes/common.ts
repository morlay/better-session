import type {
  ConversationLocation,
  ConversationNodeContext,
} from "@morlay/dsh-client-ui-conversation/client";
import type { ChatNode, ChatNodeDataMap, ChatNodeKind } from "../contract/chat-nodes.ts";

export const CHAT_SYNTHETIC_SEQ_OFFSETS = {
  interruptedAssistant: -0.9,
  interruptedFollowup: -0.8,
  processControl: -0.1,
  maxTokensNotice: 0.05,
  finalizedFollowup: 0.1,
} as const;

export function contextLocation(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
}

export function chatNode<Kind extends ChatNodeKind>(
  context: ConversationNodeContext,
  kind: Kind,
  anchorSeq: number,
  data: ChatNodeDataMap[Kind],
  options: {
    readonly location?: ConversationLocation;
    readonly visibility?: "visible" | "hidden";
  } = {},
): ChatNode<Kind> {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: "chat",
    anchorSeq,
    location: options.location ?? contextLocation(context),
    visibility: options.visibility ?? "visible",
    data,
  };
}

export function coordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
