import type { CommandId } from "@deepseek-ai/dsh-commands/brand";
import type { MessageId } from "@deepseek-ai/dsh-llm/brand";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { LlmRetryEventData } from "@deepseek-ai/dsh-llm-retry/types";
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo/client";
import type { ContextProducerView, KnownContextForm } from "./context-producer.ts";
export type { TodoItem };

export interface AssistantRequestConfig {
  provider: string;
  model: string;
  purpose?: string;
  thinking?: string;
  reasoningEffort?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: readonly string[];
}

export interface AssistantProviderMetadataView {
  provider: string;
  model: string;
}

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "image"; attachment: ImageAttachmentRef }
  | { kind: "tool-call"; callId: string; name: string; argsRaw: string }
  | { kind: "other"; block: unknown };

export interface UserMessageNode {
  kind: "user";
  seq: number;

  time: number;
  content: readonly ContentBlock[];
  source: unknown;
}

export interface AssistantTiming {
  stepStartTime: number | null;

  firstTokenTime: number | null;

  completedTime: number;
}

export interface AssistantMessageNode {
  kind: "assistant";
  seq: number;

  messageId?: MessageId;

  time: number;
  turn: number;
  step: number;
  blocks: readonly AssistantBlock[];
  usage?: unknown;
  providerMetadata?: AssistantProviderMetadataView;
  requestConfig?: AssistantRequestConfig;

  timing?: AssistantTiming;

  interrupted?: true;
}

export interface SteeringMessageNode {
  kind: "steering";

  messageId: MessageId;
  seq: number;

  time: number;
  content: readonly ContentBlock[];
  source: unknown;
}

export interface ContextMessageNode {
  kind: "context";
  seq: number;

  time: number;
  content: readonly ContentBlock[];
  source: unknown;

  producer: ContextProducerView;

  form: KnownContextForm | null;
}

export type ModelRetryNode = LlmRetryEventData & {
  kind: "model-retry";
  seq: number;

  time: number;

  retryState: "scheduled" | "started" | "cancelled";
};

export interface TurnErrorNode {
  kind: "turn-error";

  seq: number;

  time: number;
  turn: number;
  step: number;

  message: string;

  code?: string;
}

export interface TurnMaxTokensNode {
  kind: "turn-max-tokens";

  seq: number;

  time: number;
  turn: number;
  step: number;
}

export interface ToolResultNode {
  kind: "tool-result";
  seq: number;

  time: number;
  callId: string;

  parentCallId?: string;

  call: { name: string; argsRaw: string } | null;

  callTime: number | null;
  content: readonly ContentBlock[];
  isError: boolean;
  error?: { name: string; code: string; reason?: string };
  meta?: unknown;

  subCalls: readonly ToolCallBlock[];
}

export interface CompactionSummaryNode {
  kind: "compaction";

  seq: number;

  time: number;

  summary: string | null;

  summaryEventSeq: number | null;

  shadowedItemCount: number | null;

  shadowedTokenCount: number | null;
}

export interface UnknownSurfaceNode {
  kind: "unknown";
  seq: number;

  time: number;
  type: string;
  data: unknown;
}

export interface CommandNode {
  kind: "command";

  seq: number;

  time: number;

  commandId: CommandId;

  name: string | null;

  args: string | null;

  outcome: {
    kind: "success" | "error";
    text?: string;

    sourceEventSeq?: number;
  } | null;
}

export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | SteeringMessageNode
  | ContextMessageNode
  | ModelRetryNode
  | TurnErrorNode
  | TurnMaxTokensNode
  | ToolResultNode
  | CommandNode
  | CompactionSummaryNode
  | UnknownSurfaceNode;

export interface RunningToolCall {
  callId: string;

  parentCallId?: string;
  name: string;
  argsRaw: string;
  turn: number;
  step: number;

  time: number;

  subCalls: readonly ToolCallBlock[];
}

export type ToolCallBlock = RunningToolCall | ToolResultNode;

export interface PartialAssistant {
  turn: number;
  step: number;
  blocks: readonly AssistantBlock[];
}
