import type {
  ConversationNode,
  ConversationTimelineSnapshot,
  PartialAssistant,
  RunningToolCall,
} from "@morlay/dsh-client-ui-conversation/client";
import type { ChatConversationViewNode } from "./chat-nodes.ts";
import type { TurnProcessSpec } from "./turn-process.ts";

export type {
  AssistantBlock,
  AssistantMessageNode,
  AssistantProviderMetadataView,
  AssistantRequestConfig,
  AssistantTiming,
  CommandNode,
  CompactionSummaryNode,
  ContextMessageNode,
  ConversationNode,
  ModelRetryNode,
  PartialAssistant,
  RunningToolCall,
  SteeringMessageNode,
  TodoItem,
  ToolCallBlock,
  ToolResultNode,
  TurnErrorNode,
  TurnMaxTokensNode,
  UnknownSurfaceNode,
  UserMessageNode,
} from "@morlay/dsh-client-ui-conversation/client";

export interface ChatNodeSource {
  readonly getSnapshot: () => ChatConversationViewNode | undefined;

  readonly subscribe: (listener: () => void) => () => void;
}

export interface ChatNodeProcessSource {
  readonly getSnapshot: () => ChatTurnProcessPresentation | undefined;

  readonly subscribe: (listener: () => void) => () => void;
}

export interface ChatNodeStore {
  get(key: string): ChatConversationViewNode | undefined;

  source(key: string): ChatNodeSource;

  processSource(key: string): ChatNodeProcessSource;

  values(): readonly ChatConversationViewNode[];
}

export interface TurnNavigationItem {
  readonly turn: number;

  readonly anchorKey: string;

  readonly prompt: string;

  readonly response: string;
}

export interface ChatTurnNavigationIndex {
  items(): readonly TurnNavigationItem[];
}

export interface ChatLocationNodeIndex {
  getTurn(turn: number): readonly string[];

  getStep(turn: number, step: number): readonly string[];
}

export interface ChatTurnProcessPresentation {
  readonly turn: number;
  readonly spec: TurnProcessSpec;
  readonly turnClosed: boolean;
  readonly hasExternalProcess: boolean;
  readonly compactAnswer: boolean;
}

export interface LegacyConversationSlice {
  readonly nodes: readonly ConversationNode[];
  readonly turnTimings: ReadonlyMap<
    number,
    { readonly startTime: number; readonly endTime?: number }
  >;
  readonly turnEnds: ReadonlyMap<number, number>;
  readonly partial: PartialAssistant | null;
  readonly runningCalls: readonly RunningToolCall[];
}

export interface ChatSnapshot {
  readonly order: readonly string[];
  readonly nodes: ChatNodeStore;
  readonly locations: ChatLocationNodeIndex;
  readonly navigation: ChatTurnNavigationIndex;
  readonly timeline: ConversationTimelineSnapshot;
  readonly legacy: LegacyConversationSlice;
}

declare module "@morlay/dsh-client-ui-conversation/client" {
  interface ConversationViewSnapshotMap {
    chat: ChatSnapshot;
  }
}

const EMPTY_LIST: readonly never[] = [];
const EMPTY_TIMELINE: ConversationTimelineSnapshot = { turnOrder: EMPTY_LIST, turns: new Map() };
const EMPTY_NODE_SOURCE: ChatNodeSource = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
};
const EMPTY_NODE_PROCESS_SOURCE: ChatNodeProcessSource = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
};

export const EMPTY_CHAT_SNAPSHOT: ChatSnapshot = {
  order: EMPTY_LIST,
  nodes: {
    get: () => undefined,
    source: () => EMPTY_NODE_SOURCE,
    processSource: () => EMPTY_NODE_PROCESS_SOURCE,
    values: () => EMPTY_LIST,
  },
  locations: {
    getTurn: () => EMPTY_LIST,
    getStep: () => EMPTY_LIST,
  },
  navigation: {
    items: () => EMPTY_LIST,
  },
  timeline: EMPTY_TIMELINE,
  legacy: {
    nodes: EMPTY_LIST,
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: EMPTY_LIST,
  },
};
