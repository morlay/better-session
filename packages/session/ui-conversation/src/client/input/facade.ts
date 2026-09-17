import type { Context } from "@deepseek-ai/cordis";
import {
  createSnapshotStore,
  type ObservableSnapshot,
  type SnapshotStore,
} from "@deepseek-ai/dsh-client-store";
import type { LexicalEditor } from "lexical";
import type {
  CommandClaim,
  ConsumeTokenRequest,
  DraftAttachmentId,
  InputActions,
  InputEffect,
  InputNotice,
  InputState,
  InputTriggerController,
  PickOutcome,
  QueuedMessage,
  SessionInput,
  SubmitAttempt,
  SubmitAttachment,
  SubmitOutcome,
} from "../contract/input.ts";
import type {
  ArbitrateKey,
  ArbitrateOutcome,
  ComposerKeyboard,
  Occurrence,
  ReferenceInsert,
  TokenSpan,
} from "../contract/draft-editor.ts";
import type { InputSubmitMode } from "../contract/composer-submission.ts";
import { clipboardUriOf } from "./clipboard-resource.ts";
import { SubmitMachine } from "./machine.ts";
import { DraftEditorRuntime } from "./editor/runtime.ts";
import type { EditorProjection } from "./editor/projection.ts";

export interface PopupDismissFace {
  dismiss(): void;
}

export interface SessionInputDeps {
  actx: Context;

  inputTriggers?: (() => InputTriggerController | undefined) | undefined;

  popup?: (() => PopupDismissFace | undefined) | undefined;

  queue?: ObservableSnapshot<readonly QueuedMessage[]> | undefined;

  cwd?: (() => string | undefined) | undefined;

  steerQueue?: (() => void) | undefined;

  defaultSink(
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome>;

  commandAttachments: {
    serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitAttachment[]>;

    release(ids: readonly DraftAttachmentId[]): void;

    unsupportedNotice(token: string): string;
  };
}

function guardOf(phase: InputState["phase"]): "plain" | "claimed" | "frozen" {
  switch (phase) {
    case "plain":
      return "plain";
    case "claimed":
      return "claimed";
    default:
      return "frozen";
  }
}

function projectionContentChanged(prev: EditorProjection, next: EditorProjection): boolean {
  if (prev.clipboardText !== next.clipboardText || prev.detectText !== next.detectText) return true;
  if (prev.occurrences.length !== next.occurrences.length) return true;
  return next.occurrences.some((occ, i) => {
    const old = prev.occurrences[i];
    return (
      old === undefined || old.occurrenceId !== occ.occurrenceId || old.invalid !== occ.invalid
    );
  });
}

const EMPTY_QUEUE: readonly QueuedMessage[] = [];

const EMPTY_LEXICON: ReadonlyMap<"/" | "@", readonly string[]> = new Map();

interface DetachedDraft {
  readonly draft: string;
  readonly occurrences: readonly Occurrence[];
  readonly attachmentIds: readonly DraftAttachmentId[];
}

export class SessionInputShell implements SessionInput {
  readonly state: SnapshotStore<InputState>;

  readonly notices: SnapshotStore<InputNotice | null> = createSnapshotStore<InputNotice | null>(
    null,
  );

  get editor(): LexicalEditor {
    return this.draftEditor.editor;
  }

  readonly actions: InputActions = {
    setDraft: (text) => {
      this.setDraft(text);
    },
    restoreDraft: (draft) => {
      this.restoreDraft(draft);
    },
    addAttachments: (ids) => this.addAttachments(ids),
    removeAttachment: (id) => {
      this.removeAttachment(id);
    },
    pruneAttachments: (ids) => {
      this.pruneAttachments(ids);
    },
    submit: () => {
      this.submit("queue");
    },
  };

  private readonly core = new SubmitMachine();
  private readonly draftEditor: DraftEditorRuntime;
  private get projection(): EditorProjection {
    return this.draftEditor.projection;
  }
  private rev = 0;
  private readonly unregister: () => void;
  private noticeSeq = 0;
  private lastMirroredDraft = "";
  private attachmentIds: readonly DraftAttachmentId[] = [];
  private disposed = false;

  private mirrorFn: ((text: string) => void) | undefined;

  private filePicker: Parameters<ComposerKeyboard["bindFilePicker"]>[0] | undefined;

  private readonly detachedDrafts = new Map<number, DetachedDraft>();

  private readonly failedDetached = new Map<number, DetachedDraft>();

  private failedRestoreRev: number | undefined;
  private restoringFailures = false;
  private attachmentFlightSeq = 0;

  private readonly attachmentFlights = new Map<
    number,
    {
      readonly controller: AbortController;
      readonly attachmentIds: readonly DraftAttachmentId[];
    }
  >();

  constructor(private readonly deps: SessionInputDeps) {
    this.draftEditor = new DraftEditorRuntime({
      onUpdate: () => {
        this.onEditorUpdate();
      },
      openReference: (source, reference) =>
        this.deps.inputTriggers?.()?.openReference(source, reference) ?? false,
      activeClaimToken: () => this.activeClaimToken(),
      lexicon: () => this.lexicon.getSnapshot(),
      resolveLexicon: () => this.deps.inputTriggers?.()?.lexicon,
    });
    this.unregister = this.draftEditor.register();
    this.state = createSnapshotStore<InputState>(this.compose());
    deps.queue?.subscribe(() => {
      this.publish();
    });
  }

  private onEditorUpdate(): void {
    const prev = this.draftEditor.refreshProjection();

    if (projectionContentChanged(prev, this.projection)) {
      this.rev += 1;
      if (!this.restoringFailures && this.failedRestoreRev !== undefined) {
        this.failedDetached.clear();
        this.failedRestoreRev = undefined;
      }
      this.dispatchRun({ type: "draft-changed", draft: this.projection.clipboardText });
    }
    const caret = this.projection.caret;
    if (caret !== null) {
      this.deps
        .inputTriggers?.()
        ?.track(
          this.projection.detectText,
          caret,
          { tier: guardOf(this.core.state.phase) },
          this.rev,
        );
    }
  }

  setDraft(text: string): void {
    this.draftEditor.setDraft(text);
  }

  restoreDraft(draft: string): void {
    this.draftEditor.restoreDraft(draft, []);
  }

  addAttachments(ids: readonly DraftAttachmentId[]): boolean {
    if (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting")
      return false;
    if (ids.length === 0) return true;
    this.attachmentIds = [...this.attachmentIds, ...ids];
    this.publish();
    return true;
  }

  removeAttachment(id: DraftAttachmentId): boolean {
    if (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting")
      return false;
    const next = this.attachmentIds.filter((candidate) => candidate !== id);
    if (next.length === this.attachmentIds.length) return false;
    this.attachmentIds = next;
    this.publish();
    return true;
  }

  pruneAttachments(available: readonly DraftAttachmentId[]): void {
    const keep = new Set(available);
    const next = this.attachmentIds.filter((id) => keep.has(id));
    if (next.length === this.attachmentIds.length) return;
    this.attachmentIds = next;
    this.publish();
  }

  commitSend(attachmentIds: readonly DraftAttachmentId[]): void {
    const submitted = new Set(attachmentIds);
    this.attachmentIds = this.attachmentIds.filter((id) => !submitted.has(id));
    this.dispatchRun({ type: "send-committed" });
  }

  paste(text: string): void {
    this.draftEditor.paste(text);
  }

  clipboardUri(path: string): string {
    return clipboardUriOf(path, this.deps.cwd?.());
  }

  submit(mode: InputSubmitMode = "queue"): void {
    if (this.snapshot.draft.trim() === "" && this.attachmentIds.length > 0) {
      if (this.snapshot.phase === "plain") {
        const attachmentIds = [...this.attachmentIds];
        const controller = new AbortController();
        this.attachmentFlightSeq += 1;
        const flight = this.attachmentFlightSeq;
        this.attachmentFlights.set(flight, { controller, attachmentIds });
        this.commitSend(attachmentIds);
        void this.deps.defaultSink("", attachmentIds, mode, controller.signal).then(
          (outcome) => {
            if (this.disposed || !this.attachmentFlights.delete(flight)) return;
            if (outcome.kind === "success") return;
            this.restoreAttachments(attachmentIds);
            if (outcome.text !== undefined) this.notify("error", outcome.text);
          },
          (error: unknown) => {
            if (this.disposed || !this.attachmentFlights.delete(flight)) return;
            this.restoreAttachments(attachmentIds);
            this.notify("error", error instanceof Error ? error.message : String(error));
          },
        );
      }
      return;
    }

    const before = this.snapshot;
    if (
      before.phase === "claimed" &&
      this.attachmentIds.length > 0 &&
      before.claim?.attachments !== true
    ) {
      this.notify(
        "error",
        this.deps.commandAttachments.unsupportedNotice(before.claim?.token ?? before.draft),
      );
      return;
    }
    this.dispatchRun({ type: "enter", mode, draft: this.projection.clipboardText });
    const phase = this.snapshot.phase;
    if (phase === "adjudicating" || phase === "submitting") {
      this.deps.popup?.()?.dismiss();
      this.deps
        .inputTriggers?.()
        ?.track(this.projection.detectText, 0, { tier: "frozen" }, this.rev);
    }
  }

  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? "pass";
  }

  steerQueue(): void {
    this.deps.steerQueue?.();
  }

  space(): boolean {
    const inputTriggers = this.deps.inputTriggers?.();
    if (inputTriggers === undefined) return false;
    return inputTriggers.onSpace();
  }

  dismissPopup(): void {
    this.deps.popup?.()?.dismiss();
  }

  caretSpan(): { start: number; end: number } {
    return this.draftEditor.caretSpan();
  }

  readonly lexicon: ObservableSnapshot<ReadonlyMap<"/" | "@", readonly string[]>> = {
    getSnapshot: () => this.deps.inputTriggers?.()?.lexicon.getSnapshot() ?? EMPTY_LEXICON,
    subscribe: (fn) => this.deps.inputTriggers?.()?.lexicon.subscribe(fn) ?? (() => {}),
  };

  beginCommand(claim: CommandClaim, span: TokenSpan): boolean {
    const phase = this.core.state.phase;
    if (phase !== "plain" && phase !== "claimed") return false;
    if (span.draftRev !== this.rev) return false;

    if (this.projection.detectText.slice(0, span.start).trim() !== "") return false;
    const applied = this.draftEditor.replaceText({ start: 0, end: span.end }, claim.token);
    if (!applied) return false;
    this.dispatchRun({ type: "claim", claim });
    return true;
  }

  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean {
    const phase = this.core.state.phase;
    if (phase !== "plain" && phase !== "claimed") return false;
    if (span.draftRev !== this.rev) return false;
    const tail = this.projection.detectText.slice(span.end, span.end + 1);
    return this.insertText(tail === " " ? ref.clipboardText : `${ref.clipboardText} `, span);
  }

  consumeToken(guard: ConsumeTokenRequest["guard"]): boolean {
    if (guard.kind === "span") {
      if (guard.span.draftRev !== this.rev || guard.span.start === guard.span.end) return false;
      return this.draftEditor.replaceText(guard.span, "");
    }
    if (guard.token === "" || this.projection.clipboardText.trim() !== guard.token) return false;
    this.setDraft("");
    return true;
  }

  insertText(text: string, span: TokenSpan, keepCompleting = false): boolean {
    void keepCompleting;
    if (span.draftRev !== this.rev) return false;
    return this.draftEditor.replaceText(span, text);
  }

  notify(level: "info" | "error", text: string): void {
    this.noticeSeq += 1;
    this.notices.set({ level, text, seq: this.noticeSeq });
  }

  dispose(): readonly DraftAttachmentId[] {
    if (this.disposed) return [];
    const retained = new Set(this.attachmentIds);
    for (const record of this.detachedDrafts.values()) {
      for (const attachmentId of record.attachmentIds) retained.add(attachmentId);
    }
    for (const flight of this.attachmentFlights.values()) {
      for (const attachmentId of flight.attachmentIds) retained.add(attachmentId);
      flight.controller.abort();
    }
    this.disposed = true;
    this.dispatchRun({ type: "release" });
    this.unregister();
    this.detachedDrafts.clear();
    this.failedDetached.clear();
    this.attachmentFlights.clear();
    return [...retained];
  }

  get snapshot(): InputState {
    return this.state.getSnapshot();
  }

  bindMirror(write: (text: string) => void): () => void {
    this.mirrorFn = write;
    return () => {
      if (this.mirrorFn === write) this.mirrorFn = undefined;
    };
  }

  bindFilePicker(picker: Parameters<ComposerKeyboard["bindFilePicker"]>[0]): () => void {
    this.filePicker = picker;
    return () => {
      if (this.filePicker === picker) this.filePicker = undefined;
    };
  }

  canPickFiles(): boolean {
    return this.filePicker?.available() === true;
  }

  pickFiles(): boolean {
    if (this.filePicker === undefined || !this.filePicker.available()) return false;
    this.filePicker.open();
    return true;
  }

  private activeClaimToken(): string | null {
    const core = this.core.state;
    return (core.phase === "claimed" || core.phase === "submitting") && core.claim !== undefined
      ? core.claim.token
      : null;
  }

  private dispatchRun(ev: Parameters<SubmitMachine["dispatch"]>[0]): void {
    const beforeToken = this.activeClaimToken();
    this.run(this.core.dispatch(ev));
    if (this.activeClaimToken() !== beforeToken) this.draftEditor.refreshClaimDecoration();
  }

  private run(effects: readonly InputEffect[]): void {
    for (const fx of effects) this.execute(fx);
    this.publish();
  }

  private execute(fx: InputEffect): void {
    switch (fx.type) {
      case "notice": {
        this.noticeSeq += 1;
        this.notices.set({ level: fx.level, text: fx.text, seq: this.noticeSeq });
        return;
      }
      case "adjudicate": {
        this.adjudicate(fx.attempt, fx.draft);
        return;
      }
      case "begin-submit": {
        this.beginSubmit(fx.attempt, fx.claim, fx.args);
        return;
      }
      case "default-sink": {
        this.sinkSerialized(fx.attempt, fx.draft, fx.mode);
        return;
      }
      case "commit-draft": {
        this.commitDraft(fx.retainSuffixOf);
        return;
      }
    }
  }

  private commitDraft(retainSuffixOf: string | null): void {
    this.draftEditor.clearCommittedDraft((clip) => {
      if (retainSuffixOf !== null && clip !== retainSuffixOf && clip.startsWith(retainSuffixOf)) {
        return retainSuffixOf.length;
      }
      return null;
    });
    this.draftEditor.clearHistory();
  }

  private sinkSerialized(attempt: SubmitAttempt, draft: string, mode: InputSubmitMode): void {
    const attachmentIds = [...this.attachmentIds];
    this.attachmentIds = [];
    const occurrences = this.projection.occurrences;
    const record = { draft, occurrences, attachmentIds };
    this.detachedDrafts.set(attempt.seq, record);
    if (this.failedRestoreRev === this.rev) {
      this.failedDetached.clear();
      this.failedRestoreRev = undefined;
    }
    if (occurrences.length === 0) {
      this.settleSink(
        attempt,
        this.deps.defaultSink(draft.trim(), attachmentIds, mode, attempt.signal),
      );
      return;
    }
    const inputTriggers = this.deps.inputTriggers?.();
    void Promise.all(
      occurrences.map(async (o) => {
        if (inputTriggers === undefined)
          throw new Error(`no serializer for reference source "${o.source}"`);
        return {
          offset: o.offset,
          length: o.length,
          text: await inputTriggers.serializeReference(o.source, o.ref, attempt.signal),
        };
      }),
    ).then(
      (parts) => {
        if (this.disposed) return;

        let out = "";
        let cursor = 0;
        for (const part of parts) {
          out += draft.slice(cursor, part.offset) + part.text;
          cursor = part.offset + part.length;
        }
        out += draft.slice(cursor);
        this.settleSink(
          attempt,
          this.deps.defaultSink(out.trim(), attachmentIds, mode, attempt.signal),
        );
      },
      (error: unknown) => {
        if (this.dead(attempt)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.settleDetachedFailure(attempt, message);
      },
    );
  }

  private settleSink(attempt: SubmitAttempt, pending: Promise<SubmitOutcome>): void {
    pending.then(
      (outcome) => {
        if (this.dead(attempt)) return;
        if (outcome.kind !== "success") {
          this.settleDetachedFailure(attempt, outcome.text);
          return;
        }
        this.detachedDrafts.delete(attempt.seq);
        this.dispatchRun({ type: "sink-settled", attempt, ok: true, outcome });
      },
      (error: unknown) => {
        if (this.dead(attempt)) return;
        this.settleDetachedFailure(attempt, error instanceof Error ? error.message : String(error));
      },
    );
  }

  private settleDetachedFailure(attempt: SubmitAttempt, message?: string): void {
    const record = this.detachedDrafts.get(attempt.seq);
    if (record === undefined) return;
    this.detachedDrafts.delete(attempt.seq);
    this.restoreAttachments(record.attachmentIds);
    this.failedDetached.set(attempt.seq, record);
    if (this.projection.clipboardText === "" || this.failedRestoreRev === this.rev) {
      this.restoreFailedDrafts();
    }
    this.dispatchRun({
      type: "sink-settled",
      attempt,
      ok: false,
      ...(message === undefined ? {} : { message }),
    });
  }

  private restoreFailedDrafts(): void {
    const records = [...this.failedDetached.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, record]) => record);
    if (records.length === 0) return;
    const separator = "\n\n";
    let draft = "";
    const occurrences: Occurrence[] = [];
    for (const record of records) {
      const base = draft.length + (draft === "" ? 0 : separator.length);
      if (draft !== "") draft += separator;
      draft += record.draft;
      for (const occurrence of record.occurrences) {
        occurrences.push({ ...occurrence, offset: base + occurrence.offset });
      }
    }
    this.restoringFailures = true;
    try {
      this.draftEditor.restoreDraft(draft, occurrences);
      this.draftEditor.clearHistory();
      this.failedRestoreRev = this.rev;
    } finally {
      this.restoringFailures = false;
    }
  }

  private restoreAttachments(attachmentIds: readonly DraftAttachmentId[]): void {
    if (attachmentIds.length === 0) return;
    const current = new Set(this.attachmentIds);
    const restored = attachmentIds.filter((id) => !current.has(id));
    if (restored.length === 0) return;
    this.attachmentIds = [...restored, ...this.attachmentIds];
    this.publish();
  }

  private adjudicate(attempt: SubmitAttempt, draft: string): void {
    const inputTriggers = this.deps.inputTriggers?.();
    if (inputTriggers === undefined) {
      this.dispatchRun({ type: "adjudicated", attempt, outcome: undefined });
      return;
    }
    inputTriggers
      .adjudicate(draft.trim(), attempt.signal, { attachments: this.attachmentIds.length })
      .then(
        (outcome: PickOutcome) => {
          if (this.dead(attempt)) return;
          this.dispatchRun({ type: "adjudicated", attempt, outcome });
        },
        (error: unknown) => {
          if (this.dead(attempt)) return;
          const message = error instanceof Error ? error.message : String(error);
          this.dispatchRun({ type: "adjudication-failed", attempt, message });
        },
      );
  }

  private beginSubmit(attempt: SubmitAttempt, claim: CommandClaim, args: string): void {
    const attachmentIds = claim.attachments === true ? [...this.attachmentIds] : [];
    Promise.resolve()
      .then(async () => {
        const attachments =
          attachmentIds.length > 0
            ? await this.deps.commandAttachments.serialize(attachmentIds)
            : [];

        if (this.dead(attempt)) return undefined;
        return claim.submit(args, this.deps.actx, attachments);
      })
      .then(
        (outcome) => {
          if (outcome === undefined || this.dead(attempt)) return;
          if (outcome.kind === "success" && attachmentIds.length > 0) {
            const submitted = new Set(attachmentIds);
            this.attachmentIds = this.attachmentIds.filter((id) => !submitted.has(id));
            this.deps.commandAttachments.release(attachmentIds);
          }
          this.dispatchRun({
            type: "submit-settled",
            attempt,
            ok: outcome.kind === "success",
            draft: this.projection.clipboardText,
            outcome,
            ...(outcome.kind === "error" && outcome.text === undefined
              ? { message: "command failed" }
              : {}),
          });
        },
        (error: unknown) => {
          if (this.dead(attempt)) return;
          const message = error instanceof Error ? error.message : String(error);
          this.dispatchRun({
            type: "submit-settled",
            attempt,
            ok: false,
            draft: this.projection.clipboardText,
            message,
          });
        },
      );
  }

  private dead(attempt: SubmitAttempt): boolean {
    return this.disposed || attempt.signal.aborted;
  }

  private compose(): InputState {
    const core = this.core.state;
    return {
      draft: this.projection.clipboardText,
      attachmentIds: this.attachmentIds,
      draftRev: this.rev,
      phase: core.phase,
      ...(core.claim !== undefined ? { claim: core.claim } : {}),
      occurrences: this.projection.occurrences,
      queue: this.deps.queue?.getSnapshot() ?? EMPTY_QUEUE,
    };
  }

  private publish(): void {
    const next = this.compose();
    this.state.set(next);
    if (next.draft !== this.lastMirroredDraft) {
      this.lastMirroredDraft = next.draft;
      this.mirrorFn?.(next.draft);
    }
  }
}
