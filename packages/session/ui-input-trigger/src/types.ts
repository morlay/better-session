import type { ComponentType } from "react";
import type {
  PickOutcome,
  ReferenceInsert,
  TokenSpan,
} from "@morlay/dsh-client-ui-conversation/client";
import type { IconProps } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

export type {
  ArbitrateKey,
  ArbitrateOutcome,
  BeginCommandRequest,
  CommandClaim,
  ConsumeTokenRequest,
  InsertReferenceRequest,
  InsertTextRequest,
  PickOutcome,
  ReferenceInsert,
  SubmitAttachment,
  SubmitOutcome,
  TokenSpan,
} from "@morlay/dsh-client-ui-conversation/client";

export interface ClientSessionContext {
  readonly sessionId: SessionId;
}

export type TriggerChar = "/" | "@";

export type TriggerPosition = "leading" | "inline";

export type PickVia = "menu" | "space" | "enter";

export type PickAction = "pick" | "drill";

export type InputTriggerCandidateIcon = "file" | "folder" | "session";

export interface InputTriggerCandidate {
  readonly name: string;

  readonly label?: string;
  readonly description?: string;

  readonly icon?: InputTriggerCandidateIcon | ComponentType<IconProps>;
  readonly hint?: string;

  readonly section?: string;

  readonly value?: string;

  readonly drill?: boolean;
}

export interface InputTriggerCrumb {
  readonly label: string;

  readonly value: string;

  readonly current?: boolean;
}

export interface HeaderRequest {
  readonly query: string;

  readonly quoted?: boolean;

  readonly drilled: boolean;
}

export interface SubmitEnvelope {
  readonly attachments: number;
}

export interface CandidateRequest {
  readonly query: string;

  readonly quoted?: boolean;
  readonly position: TriggerPosition;

  readonly drilled: boolean;
  readonly signal: AbortSignal;
}

export interface InputTriggerPick {
  readonly candidate: InputTriggerCandidate;
  readonly session: ClientSessionContext;
  readonly position: TriggerPosition;
  readonly via: PickVia;

  readonly action: PickAction;
  readonly span: TokenSpan;
}

export interface ReferenceCodec {
  clipboardText(ref: string): string;

  serialize(ref: string, signal: AbortSignal): Promise<string>;
}

export interface InputTriggerSource {
  readonly trigger: TriggerChar;

  readonly name: string;

  readonly order?: number;

  readonly showGroupTitle?: boolean;
  candidates(
    session: ClientSessionContext,
    req: CandidateRequest,
  ): Promise<readonly InputTriggerCandidate[]>;

  header?(
    session: ClientSessionContext,
    req: HeaderRequest,
  ): readonly InputTriggerCrumb[] | undefined;

  onPick(pick: InputTriggerPick): PickOutcome;

  matchSpace?(session: ClientSessionContext, token: string): PickOutcome;

  matchEnter?(
    session: ClientSessionContext,
    line: string,
    signal: AbortSignal,
    envelope: SubmitEnvelope,
  ): Promise<PickOutcome>;

  warm?(session: ClientSessionContext): void;

  lexicon?(session: ClientSessionContext): readonly string[] | undefined;

  subscribeLexicon?(session: ClientSessionContext, listener: () => void): () => void;

  openReference?(
    session: ClientSessionContext,
    reference: Pick<ReferenceInsert, "ref" | "appearance">,
  ): boolean;

  readonly codec?: ReferenceCodec;
}

export interface TriggerGuard {
  readonly tier: "plain" | "claimed" | "frozen";
}
