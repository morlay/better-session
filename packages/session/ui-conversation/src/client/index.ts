export { apply, Config, inject } from "./apply.ts";
export type { Config as ConversationConfig } from "./apply.ts";
export { UiConversation } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembly.ts";
export type { ConversationBinding } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembly.ts";
export { ConversationController, UnsupportedImageMediaTypeError } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/service.ts";
export type { IConversation } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/service.ts";
export type {
  ConversationContextReader,
  ConversationLocation,
  ConversationLocationData,
  ConversationLocationDataScope,
  ConversationLocationDataSource,
  ConversationLocationDataStore,
  ConversationMatch,
  ConversationMatchResult,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationPreviousContext,
  ConversationPublication,
  ConversationStartMatch,
  ConversationStepDataMap,
  ConversationTimelineSnapshot,
  ConversationTurnDataMap,
  ConversationViewBuilder,
  ConversationViewDefinition,
  ConversationViewNode,
  ConversationViewSnapshotMap,
  ConversationViewSnapshotStore,
  StepLocation,
  TurnLocation,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/conversation.ts";
export { EMPTY_CONVERSATION_SNAPSHOT, conversationPhase } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/snapshot.ts";
export type { ConversationPhase, ConversationSnapshot } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/snapshot.ts";
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
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/records.ts";
export type {
  ContextProducerView,
  ContextRole,
  KnownContextForm,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/context-producer.ts";
export type {
  ConversationPromptSnapshot,
  RequestInspectionSnapshot,
  RequestPromptChange,
  RequestPromptInspection,
  RequestPromptInspector,
  RequestView,
  SystemPromptNode,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/request-inspection.ts";
export { inspectRequestPrompt } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/request-inspection.ts";
export type { SystemPromptState, SystemPromptInspector } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/system-prompt.ts";
export type { ConversationStoreState, ConversationViewRequest, ViewTab } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/views.ts";

export { ConversationNodeAssembler } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembler.ts";
export type {
  ConversationEventDefinitions,
  ConversationViewDefinitions,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembler.ts";
export { ConversationDefinitionRegistry } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/definition-registry.ts";
export { ConversationEventRegistry } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/event-registry.ts";
export { ConversationLocationIndex } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/location-index.ts";
export type { ConversationLocationDataChange } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/location-index.ts";
export { ConversationViewRegistry } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/view-registry.ts";

export type { ConversationKey } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/locales.ts";
export type {
  ComposerAttachment,
  ComposerAttachmentsOwnerProps,
  ComposerAttachmentsProps,
  ComposerFileAttachment,
  ComposerImageAttachment,
  DraftFileUpload,
  DraftFileUploads,
  ComposerBarInjected,
  ComposerBarOwnerProps,
  ComposerBarProps,
  ComposerChainProps,
  ConversationHeaderActionOwnerProps,
  ConversationHeaderCornerOwnerProps,
  ConversationHeaderLeadingOwnerProps,
  ConversationHeaderLineageOwnerProps,
  ConversationContentInputProps,
  ConversationContentProps,
  ConversationInjected,
  ConversationSessionHeaderInjected,
  ConversationSessionHeaderSlotProps,
  ConversationSessionInjected,
  ConversationSessionSlotProps,
  ConversationSlotProps,
  ConversationStore,
  ConversationViewsProps,
  ConversationWidthControlsInputProps,
  ConversationWidthControlsProps,
  ConvViewOwnerProps,
  ConvViewProps,
  EmptyWorkspaceOwnerProps,
  HeroAgentPresetOwnerProps,
  HeroBrandMarkOwnerProps,
  InputControlOwnerProps,
  InputZone,
  MessageImageLoader,
  MessageImageSource,
  MessageImagesOwnerProps,
  RenderMessageImages,
  UseConversation,
  UseConversationViews,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/slots.ts";
export type {
  BeginCommandRequest,
  CommandClaim,
  ConsumeTokenRequest,
  DraftAttachmentId,
  InputState,
  InsertReferenceRequest,
  InsertTextRequest,
  PickOutcome,
  SubmitAttachment,
  SubmitOutcome,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/input.ts";
// fork 的输入契约扩宽（`restoreDraft` + 带它的解析器）：声明在本地文件里，vendor 那份
// 仍是同一声明实例的其余部分，跨包比较因此落在同一份类型上。
export type { InputActions, SessionInput, SessionInputResolver } from "./contract/input.ts";
export type {
  ArbitrateKey,
  ArbitrateOutcome,
  ReferenceInsert,
  TokenSpan,
} from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/draft-editor.ts";
export type { ComposerBlock, ComposerBlocks } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/composer-blocks.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /**
     * 上游的会话面，但 `input` 收窄成 fork 的解析器：它的 `for(...)` 返回带
     * `restoreDraft` 的 facade（`ui-conversation-message-actions` 靠它改写草稿）。
     */
    conversation: Omit<
      import("../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/service.ts").IConversation,
      "input"
    > & { readonly input: import("./contract/input.ts").SessionInputResolver };

    uiConversation: import("../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembly.ts").UiConversation;
  }
}

export { insertTextOf, referenceTextOf } from "./input/reference-text.ts";
export { clipboardSources, pasteTextOf, resolveClipboardData } from "./input/clipboard-resource.ts";
export type { Occurrence } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/contract/draft-editor.ts";
