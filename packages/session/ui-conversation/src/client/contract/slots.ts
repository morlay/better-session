import type { ReactNode, RefObject } from "react";
import type { FileAttachmentRef, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { SessionSnapshot } from "@deepseek-ai/dsh-api-session-controller/client";
import type { FileUploadReceiptId } from "@deepseek-ai/dsh-client-file-upload/client";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type {
  MaybeSnapshotSelectorHook,
  ObservableSnapshot,
  SnapshotSelectorHook,
} from "@deepseek-ai/dsh-client-store";
import type {
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
  PropsStore,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionPendingInteraction } from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace/types";
import type { ComposerBlock } from "./composer-blocks.ts";
import type { DraftAttachmentId, InputActions, InputNotice, InputState } from "./input.ts";
import type { ComposerKeyboard, EditSelection } from "./draft-editor.ts";
import type { createConversationStore } from "../stores.ts";
import type { BusyEnterBehavior } from "./composer-submission.ts";
import type { ConversationSnapshot } from "./snapshot.ts";
import type { ViewTab } from "./views.ts";

export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;

export interface ComposerImageAttachment {
  kind: "image";
  id: DraftAttachmentId;
  file: File;
  previewUrl: string;

  width?: number;

  height?: number;
}

export interface ComposerFileAttachment {
  kind: "file";
  id: DraftAttachmentId;
  file: File;
}

export type DraftFileUpload =
  | { readonly status: "uploading"; readonly loaded: number; readonly total?: number }
  | {
      readonly status: "ready";
      readonly receiptId: FileUploadReceiptId;
      readonly file: FileAttachmentRef;
    }
  | { readonly status: "error"; readonly message: string };

export type DraftFileUploads = Readonly<Record<string, DraftFileUpload>>;

export interface ComposerAttachmentsOwnerProps {
  attachments: readonly ComposerAttachment[];

  canAcceptDrop: boolean;

  onAddFiles: (files: readonly File[]) => void;

  onRemoveAttachment: (id: DraftAttachmentId) => void;

  uploads: DraftFileUploads;

  onRetryFile: (id: DraftAttachmentId) => void;

  dropLimits?: { readonly count: number; readonly size: string } | undefined;
}

export type MessageImageSource =
  | { readonly attachment: ImageAttachmentRef }
  | {
      readonly preview: {
        readonly url: string;
        readonly name?: string;

        readonly width?: number;

        readonly height?: number;
      };
    };

export type MessageImageLoader = ((attachment: ImageAttachmentRef) => Promise<string>) & {
  peek?: (attachment: ImageAttachmentRef) => string | undefined;
};

export interface MessageImagesOwnerProps {
  images: readonly MessageImageSource[];

  loadImage: MessageImageLoader;

  align: "start" | "end";

  compact?: boolean;
}

export type RenderMessageImages = (owner: Omit<MessageImagesOwnerProps, "loadImage">) => ReactNode;

export type UseConversation = SnapshotSelectorHook<ConversationSnapshot>;

export type UseConversationViews = SnapshotSelectorHook<readonly ViewTab[]>;

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "main.conversation": { kind: "single"; scope: "session-maybe" };

    "conversation.session": { kind: "single"; scope: "session" };

    "conversation.session.header": { kind: "single"; scope: "session" };

    "conversation.session.header.lineage": {
      kind: "single";
      scope: "session";
      owner: ConversationHeaderLineageOwnerProps;
    };

    "conversation.session.header.actions": {
      kind: "list";
      scope: "session";
      owner: ConversationHeaderActionOwnerProps;
    };

    "conversation.session.header.utilities": {
      kind: "list";
      scope: "session";
      owner: ConversationHeaderActionOwnerProps;
    };

    "conversation.session.header.corner": {
      kind: "single";
      scope: "session";
      owner: ConversationHeaderCornerOwnerProps;
    };

    "conversation.view": { kind: "list"; scope: "session"; owner: ConvViewOwnerProps };

    "conversation.composer": { kind: "chain"; scope: "session"; owner: ComposerChainProps };

    "conversation.hero.workspace": {
      kind: "single";
      scope: "root";
      owner: EmptyWorkspaceOwnerProps;
    };

    "conversation.hero.brand.mark": {
      kind: "single";
      scope: "root";
      owner: HeroBrandMarkOwnerProps;
    };

    "conversation.hero.agentPreset": {
      kind: "single";
      scope: "root";
      owner: HeroAgentPresetOwnerProps;
    };

    "conversation.input.dock": { kind: "list"; scope: "session"; owner: InputZone };

    "conversation.input.overlay": { kind: "list"; scope: "session" };

    "conversation.composer.dock": { kind: "list"; scope: "session" };

    "conversation.input.left": { kind: "list"; scope: "session" };

    "conversation.input.right": { kind: "list"; scope: "session" };

    "conversation.composer.bar": {
      kind: "single";
      scope: "session-maybe";
      owner: ComposerBarOwnerProps;
    };

    "conversation.input.attachments": {
      kind: "single";
      scope: "session-maybe";
      owner: ComposerAttachmentsOwnerProps;
    };

    "conversation.input.plan": { kind: "single"; scope: "session"; owner: InputControlOwnerProps };

    "conversation.input.permission": {
      kind: "single";
      scope: "session";
      owner: InputControlOwnerProps;
    };

    "conversation.input.model": { kind: "single"; scope: "session"; owner: InputControlOwnerProps };
  }

  interface GlobalStandardProps {
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>;
  }

  interface SessionStandardProps {
    useConversation: UseConversation;

    useInput: SnapshotSelectorHook<InputState>;

    inputActions: InputActions;
  }

  interface SessionMaybeStandardProps {
    useConversation: MaybeSnapshotSelectorHook<ConversationSnapshot>;

    useInput: MaybeSnapshotSelectorHook<InputState>;

    inputActions: InputActions | undefined;
  }
}

export interface HeroAgentPresetOwnerProps {
  children?: never;
}

export interface ConversationHeaderActionOwnerProps {
  children?: never;
}

export interface ConversationHeaderCornerOwnerProps {
  children?: never;
}

export interface ConversationHeaderLineageOwnerProps {
  lineageSessionId: SessionId;

  displayTitle: string;

  openTitle?: () => void;
}

export interface InputZone {
  readonly session: SessionSnapshot;
  readonly input: InputState;
}

export interface ConvViewOwnerProps {
  viewRequest: import("./views.ts").ConversationViewRequest | null;

  openView: (view: string, focus: string) => void;

  completeViewRequest: () => void;
}

export type ConvViewProps = PropsRuntime<"conversation.view">;

export interface ConversationInjected {
  selectWorkspace: (workspaceId: WorkspaceId) => Promise<void>;

  hooks: { composerBlock: ObservableSnapshot<ComposerBlock | undefined> };
}

export interface ConversationSessionInjected {
  readonly hooks: { readonly conversationViews: ObservableSnapshot<readonly ViewTab[]> };

  bindDraftMirror: (write: (text: string) => void) => () => void;

  openView: (view: string, focus: string) => void;
}

export interface ConversationSessionHeaderInjected {
  readonly hooks: { readonly conversationViews: ObservableSnapshot<readonly ViewTab[]> };

  open: (sessionId: SessionId) => void;

  selectView: (view: string) => void;
}

export interface ComposerBarOwnerProps {
  variant: "hero" | "composer";

  blocked?: { readonly reason: string };

  disabled?: boolean;

  workspacePickerOpen?: boolean;

  onRequestWorkspace?: () => void;
  placeholder?: string;

  accessory?: ReactNode;
}

export interface ComposerBarInjected {
  keyboard: ComposerKeyboard | undefined;
  addFiles: ((files: readonly File[]) => string | null) | undefined;
  removeAttachment: ((id: DraftAttachmentId) => void) | undefined;
  resolveDraftAttachments:
    | ((ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[])
    | undefined;

  retryFileUpload: ((id: DraftAttachmentId) => void) | undefined;
  toggleCommandMenu: ((selection: EditSelection) => void) | undefined;
  stop: (() => void) | undefined;
  hooks: {
    busyEnter: ObservableSnapshot<BusyEnterBehavior>;

    fileUploads: ObservableSnapshot<DraftFileUploads>;
    notices: ObservableSnapshot<InputNotice | null>;
    lexicon: ObservableSnapshot<ReadonlyMap<"/" | "@", readonly string[]>>;
    menuLauncher: ObservableSnapshot<string | null>;
  };
}

export interface InputControlOwnerProps {
  locked: boolean;
}

export type ComposerBarProps = PropsRuntime<"conversation.composer.bar"> &
  PropsRenderSlots<
    | "conversation.input.attachments"
    | "conversation.input.overlay"
    | "conversation.input.permission"
    | "conversation.input.left"
    | "conversation.input.plan"
    | "conversation.input.right"
    | "conversation.input.model"
    | "conversation.composer.dock"
  > &
  InjectFace<ComposerBarInjected> &
  PropsLocale<"conversation">;

export interface ComposerChainProps {
  sessionId: SessionId | undefined;

  session: SessionSnapshot | undefined;

  pendingInteraction: SessionPendingInteraction | undefined;
}

export interface HeroBrandMarkOwnerProps {
  size: number;

  className?: string | undefined;
}

export type ConversationSlotProps = PropsRuntime<"main.conversation"> &
  PropsRenderSlots<
    | "conversation.session"
    | "conversation.session.header"
    | "conversation.composer"
    | "conversation.composer.bar"
    | "conversation.input.dock"
    | "conversation.hero.brand.mark"
    | "conversation.hero.workspace"
    | "conversation.hero.agentPreset"
  > &
  InjectFace<ConversationInjected> &
  PropsLocale<"conversation">;

export type ConversationStore = ReturnType<typeof createConversationStore>;

export type ConversationSessionSlotProps = PropsRuntime<"conversation.session"> &
  PropsRenderSlots<"conversation.view"> &
  PropsStore<ConversationStore> &
  InjectFace<ConversationSessionInjected>;

export type ConversationSessionHeaderSlotProps = PropsRuntime<"conversation.session.header"> &
  PropsRenderSlots<
    | "conversation.session.header.lineage"
    | "conversation.session.header.actions"
    | "conversation.session.header.utilities"
    | "conversation.session.header.corner"
  > &
  PropsStore<ConversationStore> &
  InjectFace<ConversationSessionHeaderInjected> &
  PropsLocale<"conversation">;

export type ComposerAttachmentsProps = PropsRuntime<"conversation.input.attachments"> &
  PropsLocale<"conversation">;

export interface EmptyWorkspaceOwnerProps {
  open: boolean;
  anchorRef?: RefObject<HTMLElement>;

  selectedId?: WorkspaceId | undefined;
  onPick: (workspaceId: WorkspaceId) => void;
  onClose: () => void;
}
