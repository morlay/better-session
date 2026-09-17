import type {
  ConversationNode,
  ConversationPromptSnapshot,
} from "@morlay/dsh-client-ui-conversation/client";

export type ConversationContextOriginKind = "compaction" | "rewind" | "rewrite";

export interface ConversationContext {
  id: number;

  parentId?: number;

  origin?: ConversationContextOriginKind;

  originSeq?: number;

  createdAt?: number;

  prompt?: ConversationPromptSnapshot;

  nodes: readonly ConversationNode[];
}
