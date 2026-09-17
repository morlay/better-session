import type { LexicalEditor } from "lexical";
import type { InputState } from "./input.ts";
import type { InputSubmitMode } from "./composer-submission.ts";

export interface TokenSpan {
  readonly start: number;
  readonly end: number;
  readonly draftRev: number;
}

export interface ReferenceInsert {
  readonly source: string;
  readonly ref: string;
  readonly label: string;

  readonly appearance?: "session" | "file" | "folder" | "skill";
  readonly clipboardText: string;
}

export type ArbitrateKey = "up" | "down" | "enter" | "escape" | "tab";

export type ArbitrateOutcome = "consumed" | "pick-highlighted" | "pass";

export interface ComposerKeyboard {
  readonly snapshot: InputState;

  readonly editor: LexicalEditor;

  submit(mode: InputSubmitMode): void;

  steerQueue(): void;

  paste(text: string): void;

  clipboardUri(path: string): string;

  caretSpan(): EditSelection;

  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome;

  space(): boolean;

  dismissPopup(): void;

  bindFilePicker(picker: { available(): boolean; open(): void }): () => void;
}

export interface EditSelection {
  readonly start: number;
  readonly end: number;
}

export interface Occurrence {
  readonly occurrenceId: number;

  readonly source: string;

  readonly ref: string;

  readonly offset: number;

  readonly length: number;

  readonly label: string;

  readonly appearance?: ReferenceInsert["appearance"];

  readonly clipboardText: string;

  readonly invalid?: boolean;
}
