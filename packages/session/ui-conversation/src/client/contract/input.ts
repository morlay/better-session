import type { Context } from "@deepseek-ai/cordis";
import type { ObservableSnapshot, SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { Branded } from "@deepseek-ai/dsh-brand";
import type {
  ArbitrateKey,
  ArbitrateOutcome,
  Occurrence,
  ReferenceInsert,
  TokenSpan,
} from "./draft-editor.ts";
import type { QueueRow } from "./queue.ts";
import type { InputSubmitMode } from "./composer-submission.ts";

export type SubmitAttachment =
  | {
      readonly type: "image";
      readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      readonly data: string;
      readonly name?: string;
    }
  | { readonly type: "file"; readonly receiptId: string };

export interface DraftAttachmentSerializationResult {
  readonly attachments: readonly SubmitAttachment[];
}

export interface SubmitOutcome {
  readonly kind: "success" | "error";
  readonly text?: string;
}

export interface CommandClaim {
  readonly name: string;

  readonly token: string;
  readonly hint?: string;
  readonly attachments?: boolean;

  submit(
    args: string,
    actx: Context,
    attachments: readonly SubmitAttachment[],
  ): Promise<SubmitOutcome>;
}

export type PickOutcome =
  | { readonly claim: CommandClaim }
  | { readonly insert: ReferenceInsert }
  | { readonly text: string; readonly continue?: boolean }
  | "handled"
  | undefined;

export interface BeginCommandRequest {
  readonly claim: CommandClaim;
  readonly span: TokenSpan;
}

export interface InsertReferenceRequest {
  readonly reference: ReferenceInsert;
  readonly span: TokenSpan;
}

export interface ConsumeTokenRequest {
  readonly guard:
    | { readonly kind: "span"; readonly span: TokenSpan }
    | { readonly kind: "bare-token"; readonly token: string };
}

export interface InsertTextRequest {
  readonly text: string;
  readonly span: TokenSpan;
  readonly continue?: boolean;
}

export interface InputTriggerHit {
  readonly trigger: "/" | "@";
  readonly query: string;
  readonly quoted: boolean;
  readonly position: "leading" | "inline";
  readonly span: TokenSpan;
}

export interface InputTriggerController {
  readonly launcher: ObservableSnapshot<string | null>;
  readonly lexicon: ObservableSnapshot<ReadonlyMap<"/" | "@", readonly string[]>>;

  track(
    draft: string,
    caret: number,
    guard: { readonly tier: "plain" | "claimed" | "frozen" },
    draftRev: number,
  ): void;

  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome;

  onSpace(): boolean;

  serializeReference(source: string, ref: string, signal: AbortSignal): Promise<string>;

  adjudicate(
    line: string,
    signal: AbortSignal,
    envelope: { readonly attachments: number },
  ): Promise<PickOutcome>;

  openReference(
    source: string | undefined,
    reference: Pick<ReferenceInsert, "ref" | "appearance">,
  ): boolean;

  toggleSource(source: string, hit: InputTriggerHit): void;
}

declare module "@deepseek-ai/cordis" {
  interface Events {
    "slash/input-begin-command"(request: BeginCommandRequest): true | undefined;

    "slash/input-insert-reference"(request: InsertReferenceRequest): true | undefined;

    "slash/input-consume-token"(request: ConsumeTokenRequest): true | undefined;

    "slash/input-insert-text"(request: InsertTextRequest): true | undefined;
  }
}

export type DraftAttachmentId = Branded<"DraftAttachmentId">;

export interface InputTarget {
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean;

  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean;
}

export interface SessionInput extends InputTarget {
  setDraft(text: string): void;

  restoreDraft(draft: string): void;

  addAttachments(ids: readonly DraftAttachmentId[]): boolean;

  removeAttachment(id: DraftAttachmentId): boolean;

  pruneAttachments(ids: readonly DraftAttachmentId[]): void;

  submit(mode?: InputSubmitMode): void;

  notify(level: "info" | "error", text: string): void;

  readonly state: SnapshotStore<InputState>;
}

export interface SessionInputResolver {
  for(actx: Context): SessionInput;
}

export interface InputActions {
  setDraft(text: string): void;

  restoreDraft(draft: string): void;

  addAttachments(ids: readonly DraftAttachmentId[]): boolean;

  removeAttachment(id: DraftAttachmentId): void;

  pruneAttachments(ids: readonly DraftAttachmentId[]): void;

  submit(): void;
}

export interface InputNotice {
  readonly level: "info" | "error";
  readonly text: string;
  readonly seq: number;
}

export type QueuedMessage = QueueRow;

export type ConsumeTokenGuard = ConsumeTokenRequest["guard"];

export interface InputState {
  readonly draft: string;

  readonly attachmentIds: readonly DraftAttachmentId[];

  readonly draftRev: number;
  readonly phase: "plain" | "adjudicating" | "claimed" | "submitting";

  readonly claim?: {
    readonly name: string;
    readonly token: string;
    readonly hint?: string;
    readonly attachments?: boolean;
  };

  readonly occurrences: readonly Occurrence[];

  readonly queue: readonly QueuedMessage[];
}

export interface SubmitAttempt {
  readonly seq: number;
  readonly signal: AbortSignal;

  readonly draftSnapshot: string;

  readonly mode: InputSubmitMode;
}

export type InputEvent =
  | { readonly type: "draft-changed"; readonly draft: string }
  | { readonly type: "claim"; readonly claim: CommandClaim }
  | { readonly type: "enter"; readonly mode: InputSubmitMode; readonly draft: string }
  | { readonly type: "adjudicated"; readonly attempt: SubmitAttempt; readonly outcome: PickOutcome }
  | {
      readonly type: "adjudication-failed";
      readonly attempt: SubmitAttempt;
      readonly message: string;
    }
  | {
      readonly type: "submit-settled";
      readonly attempt: SubmitAttempt;
      readonly ok: boolean;
      readonly draft: string;
      readonly outcome?: SubmitOutcome;
      readonly message?: string;
    }
  | {
      readonly type: "sink-settled";
      readonly attempt: SubmitAttempt;
      readonly ok: boolean;
      readonly outcome?: SubmitOutcome;
      readonly message?: string;
    }
  | { readonly type: "send-committed" }
  | { readonly type: "release" };

export type InputEffect =
  | { readonly type: "adjudicate"; readonly attempt: SubmitAttempt; readonly draft: string }
  | {
      readonly type: "begin-submit";
      readonly attempt: SubmitAttempt;
      readonly claim: CommandClaim;
      readonly args: string;
    }
  | {
      readonly type: "default-sink";
      readonly attempt: SubmitAttempt;
      readonly draft: string;
      readonly mode: InputSubmitMode;
    }
  | { readonly type: "notice"; readonly level: "info" | "error"; readonly text: string }
  | { readonly type: "commit-draft"; readonly retainSuffixOf: string | null };
