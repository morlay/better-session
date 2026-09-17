import type {
  AssistantBlock,
  AssistantMessageNode,
  CommandNode,
  CompactionSummaryNode,
  ConversationLocation,
  ConversationViewNode,
  ModelRetryNode,
  RunningToolCall,
  ToolCallBlock,
} from "@morlay/dsh-client-ui-conversation/client";

export interface ChatConversationViewNode extends ConversationViewNode {
  readonly target: "chat";
  readonly anchorSeq: number;
  readonly location: ConversationLocation;
  readonly visibility: "visible" | "hidden";
}

export interface ChatNodeDataMap {}

export type ChatNodeKind = Extract<keyof ChatNodeDataMap, string>;

export type ChatNode<Kind extends ChatNodeKind = ChatNodeKind> = {
  [RegisteredKind in Kind]: ChatConversationViewNode & {
    readonly kind: RegisteredKind;
    readonly data: ChatNodeDataMap[RegisteredKind];
  };
}[Kind];

export interface AssistantChatData {
  readonly status: "running" | "settled" | "interrupted";
  readonly turn: number;
  readonly step: number;
  readonly blocks: readonly AssistantBlock[];
  readonly time: number;
  readonly usage?: unknown;
  readonly finalNode?: AssistantMessageNode;
}

export type FinalAssistantChatData = AssistantChatData & {
  readonly finalNode: AssistantMessageNode;
};

export interface ToolChatData {
  readonly root: ToolCallBlock;
}

export interface ManualCompactionChatData {
  readonly command: CommandNode;
  readonly compaction: CompactionSummaryNode | null;
}

export interface RetryChatData {
  readonly attempts: readonly ModelRetryNode[];
  readonly current: ModelRetryNode;
}

export interface TurnTokenUsageRoute {
  readonly provider: string;
  readonly model: string;
}

export interface TurnTokenUsage {
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;

  readonly totalTokens: number;

  readonly cacheReadTokens?: number;

  readonly cacheWriteTokens?: number;

  readonly reasoningTokens?: number;

  readonly routes?: readonly TurnTokenUsageRoute[];
}

export interface TurnTailChatData {
  readonly turn: number;
  readonly seq: number;
  readonly time: number;

  readonly closing: FinalAssistantChatData | null;

  readonly branchUnavailable: boolean;
  readonly ttftMs?: number;
  readonly tokensPerSecond?: number;

  readonly tokenUsage?: TurnTokenUsage;
}

export interface TurnProcessChatData {
  readonly turn: number;
  readonly controlAnchorSeq: number;
  readonly processStartSeq: number;
  readonly answerAnchorSeq: number | null;
  readonly answerStep: number | null;
  readonly inlineReasoning: boolean;
  readonly messageCount: number;
  readonly toolCallCount: number;
  readonly subagentCount: number;
}

export function isSettledTool(
  block: ToolCallBlock,
): block is Extract<ToolCallBlock, { kind: "tool-result" }> {
  return "kind" in block;
}

export function isRunningTool(block: ToolCallBlock): block is RunningToolCall {
  return !isSettledTool(block);
}
