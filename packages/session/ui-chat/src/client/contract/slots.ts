import type { MessageId } from "@deepseek-ai/dsh-llm/brand";
import type { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import type {
  CommandNode,
  CompactionSummaryNode,
  ConversationLocationDataStore,
  ConversationTurnDataMap,
  MessageImageLoader,
  MessageImagesOwnerProps,
  RenderMessageImages,
  TurnLocation,
} from "@morlay/dsh-client-ui-conversation/client";
import type {
  InjectFace,
  KeyedSnapshotSelectorHook,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
  PropsStore,
  SlotHookFactory,
  SnapshotSelectorHook,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { MarkdownFileMentions } from "@deepseek-ai/dsh-client-ui-primitives";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { createChatStore } from "../stores.ts";
import type { ToolCallId } from "./store.ts";
import type { ChatConversationViewNode, ChatNode, ChatNodeKind } from "./chat-nodes.ts";
import type {
  ChatNodeProcessSource,
  ChatNodeSource,
  ChatSnapshot,
  ChatTurnProcessPresentation,
} from "./snapshot.ts";
import type { TurnProcessSpec } from "./turn-process.ts";
import type { TranscriptViewMode } from "../../chat-settings.ts";

export type UseChat = SnapshotSelectorHook<ChatSnapshot>;

export type UseChatNode = KeyedSnapshotSelectorHook<ChatConversationViewNode | undefined>;

export type UseChatNodeProcess = KeyedSnapshotSelectorHook<ChatTurnProcessPresentation | undefined>;

export interface OpenFileOptions {
  readonly line?: number;
}

export interface TurnTailOwnerProps {
  turn: TurnLocation;
  seq: number;
  openFile: (path: string) => void;
}

export interface AssistantActionOwnerProps {
  messageId: MessageId;
}

export interface ChatFileMentions {
  forClosing(owner: TurnTailOwnerProps, sessionId: SessionId): MarkdownFileMentions | undefined;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    chatFileMentions: ChatFileMentions;
  }
}

export type UseChatNodeTurnData = <Key extends Extract<keyof ConversationTurnDataMap, string>>(
  key: Key,
) => Readonly<ConversationTurnDataMap[Key]> | undefined;

export interface ChatNodeTurnDataInjected {
  hooks: { turnData: SlotHookFactory<"conversation.chat.node", UseChatNodeTurnData> };
}

export interface ChatNodeOwnerProps {
  cwd?: string | undefined;

  openSkill: (name: string) => void;
  openFile: (path: string, options?: OpenFileOptions) => void;
  inspectCall: (callId: ToolCallId) => void;
  forkAt: (seq: number) => void;

  loadImage: MessageImageLoader;
  renderMessageImages: RenderMessageImages;
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined;

  turnProcess?: TurnProcessOwnerProps | undefined;
}

export interface TurnProcessOwnerProps {
  readonly spec: TurnProcessSpec;
  readonly foldable: boolean;
  readonly open: boolean;
  setOpen(open: boolean): void;
}

export type ChatNodeViewProps<Kind extends ChatNodeKind = ChatNodeKind> = PropsRuntime<
  "conversation.chat.node",
  Kind
> &
  PropsLocale<"chat">;

export interface CommandRowOwnerProps {
  node: CommandNode;
  compaction?: CompactionSummaryNode;
}

export type CommandRowProps = PropsRuntime<"conversation.chat.commandview">;

export type ChatStore = ReturnType<typeof createChatStore>;

export interface ChatScrollPosition {
  readonly anchorKey: string;
  readonly anchorTop: number;
  readonly scrollTop: number;
}

export interface ChatViewInjected {
  hooks: {
    transcriptView: SnapshotStore<TranscriptViewMode>;
  };
  keyedHooks: {
    chatNode: (key: string) => ChatNodeSource;

    chatNodeProcess: (key: string) => ChatNodeProcessSource;
  };

  openSkill: (name: string) => void;
  openFile: (path: string, options?: OpenFileOptions) => Promise<void>;
  loadOlder: () => void;

  loadThrough: (seq: SessionSeq) => Promise<void>;
  loadImage: MessageImageLoader;
  chatScroll: {
    save: (position: ChatScrollPosition | null) => void;
    read: () => ChatScrollPosition | null;
  };
  forkAt: (seq: number) => void;
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined;
}

export type ChatViewSlotProps = PropsRuntime<"conversation.view"> &
  PropsRenderSlots<"conversation.chat.node" | "conversation.message.images"> &
  PropsStore<ChatStore> &
  InjectFace<ChatViewInjected> &
  PropsLocale<"chat">;

export type MessageImagesProps = PropsRuntime<"conversation.message.images"> &
  PropsLocale<"conversation">;

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SessionStandardProps {
    useChat: UseChat;
  }

  interface LocaleNamespaceMap {
    chat: import("../locale.ts").ChatKey;
  }

  interface SlotMap {
    "conversation.chat.node": {
      kind: "keyed";
      scope: "session";
      owner: ChatNodeOwnerProps;
      keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } };
      hookContext: ConversationLocationDataStore<ConversationTurnDataMap> | undefined;
      inject: ChatNodeTurnDataInjected;
    };

    "conversation.message.images": {
      kind: "single";
      scope: "session";
      owner: MessageImagesOwnerProps;
    };

    "conversation.chat.commandview": {
      kind: "keyed";
      scope: "session";
      owner: CommandRowOwnerProps;
    };

    "conversation.chat.turnTail": { kind: "chain"; scope: "session"; owner: TurnTailOwnerProps };

    "conversation.chat.assistant-actions": {
      kind: "list";
      scope: "session";
      owner: AssistantActionOwnerProps;
    };
  }
}
