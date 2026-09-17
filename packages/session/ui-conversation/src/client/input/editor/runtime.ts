import type { ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import type { LexicalEditor, NodeKey } from "lexical";
import {
  $addUpdateTag,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CLEAR_HISTORY_COMMAND,
  createEditor,
  HISTORY_MERGE_TAG,
  PASTE_TAG,
} from "lexical";
import { registerPlainText } from "@lexical/plain-text";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { mergeRegister } from "@lexical/utils";
import type { Occurrence, ReferenceInsert } from "../../contract/draft-editor.ts";
import { registerReferenceActivation } from "./reference-activation.ts";
import { ReferenceChipNode } from "./chip-node.tsx";
import { refreshClaimDecoration, registerClaimDecoration } from "./claim-decor.ts";
import { registerTextRefDecoration, rescanTextRefs, TextRefNode } from "./text-ref.ts";
import type { EditorProjection } from "./projection.ts";
import { $composerLayout, $projectComposer, detectOffsetOfClipboardOffset } from "./projection.ts";
import { $replaceDetectSpanWithText } from "./span-map.ts";
import type { DetectSpan } from "./span-map.ts";

type Lexicon = ReadonlyMap<"/" | "@", readonly string[]>;

interface DraftEditorRuntimeDeps {
  readonly onUpdate: () => void;
  readonly openReference: (
    source: string | undefined,
    reference: Pick<ReferenceInsert, "ref" | "appearance">,
  ) => boolean;
  readonly activeClaimToken: () => string | null;
  readonly lexicon: () => Lexicon;
  readonly resolveLexicon: () => ObservableSnapshot<Lexicon> | undefined;
}

const REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu;

const HISTORY_MERGE_DELAY_MS = 1000;

export class DraftEditorRuntime {
  readonly editor: LexicalEditor;
  private projected: EditorProjection = {
    detectText: "",
    clipboardText: "",
    occurrences: [],
    selection: null,
    caret: null,
  };

  private readonly occurrenceIds = new Map<NodeKey, number>();
  private occurrenceSeq = 0;

  private lexiconOff: (() => void) | undefined;

  constructor(private readonly deps: DraftEditorRuntimeDeps) {
    this.editor = createEditor({
      namespace: "dsh-composer",
      nodes: [ReferenceChipNode, TextRefNode],
      onError: (error) => {
        throw error;
      },
    });
  }

  register(): () => void {
    const unregister = mergeRegister(
      registerPlainText(this.editor),
      registerReferenceActivation(this.editor, (source, reference) =>
        this.deps.openReference(source, reference),
      ),
      registerHistory(this.editor, createEmptyHistoryState(), HISTORY_MERGE_DELAY_MS),
      this.editor.registerUpdateListener(() => {
        this.deps.onUpdate();
      }),
      registerClaimDecoration(this.editor, () => this.deps.activeClaimToken()),
      registerTextRefDecoration(
        this.editor,
        () => this.deps.lexicon(),
        () => this.deps.activeClaimToken(),
      ),
      () => {
        this.lexiconOff?.();
      },
    );
    return () => {
      unregister();
      this.editor.setRootElement(null);
    };
  }

  get projection(): EditorProjection {
    return this.projected;
  }

  private applyEdit(fn: () => void, tag?: string): void {
    if (this.editor._updating) {
      if (tag !== undefined) $addUpdateTag(tag);
      fn();
      return;
    }
    this.editor.update(fn, { discrete: true, ...(tag === undefined ? {} : { tag }) });
  }

  private ensureLexiconSubscription(): void {
    if (this.lexiconOff !== undefined) return;
    const lexicon = this.deps.resolveLexicon();
    if (lexicon === undefined) return;
    this.lexiconOff = lexicon.subscribe(() => {
      rescanTextRefs(this.editor);
    });
  }

  refreshProjection(): EditorProjection {
    this.ensureLexiconSubscription();
    const prev = this.projected;
    this.projected = this.editor
      .getEditorState()
      .read(() => $projectComposer((key) => this.occurrenceIdOf(key)));
    return prev;
  }

  private occurrenceIdOf(key: NodeKey): number {
    const existing = this.occurrenceIds.get(key);
    if (existing !== undefined) return existing;
    this.occurrenceSeq += 1;
    this.occurrenceIds.set(key, this.occurrenceSeq);
    return this.occurrenceSeq;
  }

  setDraft(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, "");
    if (clean === this.projection.clipboardText) return;
    this.editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        for (const line of clean.split("\n")) {
          const paragraph = $createParagraphNode();
          if (line !== "") paragraph.append($createTextNode(line));
          root.append(paragraph);
        }
        root.selectEnd();
      },
      { discrete: true, tag: HISTORY_MERGE_TAG },
    );
  }

  paste(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, "");
    if (clean === "") return;
    this.applyEdit(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertText(clean);
        return;
      }

      const root = $getRoot();
      if (root.getChildrenSize() === 0) root.append($createParagraphNode());
      root.selectEnd().insertText(clean);
    }, PASTE_TAG);
  }

  caretSpan(): { start: number; end: number } {
    if (this.projection.selection !== null) return this.projection.selection;
    const at = this.projection.detectText.length;
    return { start: at, end: at };
  }

  replaceText(span: DetectSpan, text: string): boolean {
    let applied = false;
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithText(span, text);
    });
    return applied;
  }

  refreshClaimDecoration(): void {
    refreshClaimDecoration(this.editor);
  }

  clearCommittedDraft(prefixLength: (clipboardText: string) => number | null): void {
    this.editor.update(
      () => {
        const layout = $composerLayout();
        const length = prefixLength(layout.clipboardText);
        if (length !== null) {
          $replaceDetectSpanWithText(
            { start: 0, end: detectOffsetOfClipboardOffset(layout, length) },
            "",
          );
          return;
        }
        const root = $getRoot();
        root.clear();
        root.selectEnd();
      },
      { discrete: true, tag: HISTORY_MERGE_TAG },
    );
  }

  restoreDraft(draft: string, occurrences: readonly Occurrence[]): void {
    this.editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        let paragraph = $createParagraphNode();
        root.append(paragraph);
        const appendText = (text: string): void => {
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (line !== "") paragraph.append($createTextNode(line));
            if (i < lines.length - 1) {
              paragraph = $createParagraphNode();
              root.append(paragraph);
            }
          }
        };
        let cursor = 0;
        for (const occurrence of occurrences) {
          appendText(draft.slice(cursor, occurrence.offset));
          paragraph.append(
            new ReferenceChipNode(
              {
                source: occurrence.source,
                ref: occurrence.ref,
                label: occurrence.label,
                ...(occurrence.appearance === undefined
                  ? {}
                  : { appearance: occurrence.appearance }),
                clipboardText: occurrence.clipboardText,
              },
              occurrence.invalid === true,
            ),
          );
          cursor = occurrence.offset + occurrence.length;
        }
        appendText(draft.slice(cursor));
        root.selectEnd();
      },
      { discrete: true, tag: HISTORY_MERGE_TAG },
    );
  }

  clearHistory(): void {
    this.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }
}
