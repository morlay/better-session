import type { MouseEvent, MutableRefObject, RefObject } from "react";
import type { LexicalEditor } from "lexical";
import type { ComposerKeyboard } from "../../contract/draft-editor.ts";
import type { ComposerBarProps } from "../../contract/slots.ts";
import type { BusyEnterBehavior } from "../../contract/composer-submission.ts";
import { resolveSubmitMode } from "../submission-policy.ts";
import { registerComposerKeymap } from "./keymap.ts";

interface DraftViewGate {
  locked: boolean;
  machineBusy: boolean;
  canSteerQueue: boolean;
  running: boolean;
  steeringAvailable: boolean;
  busyEnter: BusyEnterBehavior;
  intakeFiles: (files: readonly File[]) => void;
  uploadsPending: boolean;
  showToast: (text: string) => void;
  t: ComposerBarProps["t"];
  canAcceptDrop: boolean;
}

export function revealDraftSelection(scrollRef: RefObject<HTMLDivElement>): void {
  const scrollEl = scrollRef.current;
  if (scrollEl === null || scrollEl.scrollHeight <= scrollEl.clientHeight) return;
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) {
    const anchor = selection.anchorNode;
    const el = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
    if (el === undefined || el === null) return;
    rect = el.getBoundingClientRect();
  }
  const box = scrollEl.getBoundingClientRect();
  if (rect.bottom > box.bottom) scrollEl.scrollTop += rect.bottom - box.bottom;
  else if (rect.top < box.top) scrollEl.scrollTop -= box.top - rect.top;
}

export function focusDraftEditor(editor: LexicalEditor, revealSelection: () => void): void {
  editor.getRootElement()?.focus({ preventScroll: true });
  editor.focus(() => {
    revealSelection();
  });
}

export function installDraftWheel(scrollRef: RefObject<HTMLDivElement>): (() => void) | undefined {
  const el = scrollRef.current;
  if (el === null) return;
  const onWheel = (e: WheelEvent): void => {
    const host = el.closest("[data-conversation-scroll]");
    if (!(host instanceof HTMLElement) || e.deltaY === 0) return;
    const atTop = el.scrollTop <= 0;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd)) return;
    e.preventDefault();
    host.scrollTop += e.deltaY;
  };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    el.removeEventListener("wheel", onWheel);
  };
}

export function installDraftFilePicker(
  keyboard: ComposerKeyboard,
  gate: MutableRefObject<Pick<DraftViewGate, "canAcceptDrop">>,
  fileInputRef: RefObject<HTMLInputElement>,
): () => void {
  return keyboard.bindFilePicker({
    available: () => gate.current.canAcceptDrop && fileInputRef.current !== null,
    open: () => {
      fileInputRef.current?.click();
    },
  });
}

export function installDraftKeymap(
  editor: LexicalEditor,
  keyboard: ComposerKeyboard,
  gate: MutableRefObject<DraftViewGate>,
): () => void {
  return registerComposerKeymap(editor, {
    arbitrate: (key, composing) => keyboard.arbitrate(key, composing),
    space: () => {
      if (gate.current.machineBusy || gate.current.locked) return false;
      return keyboard.space();
    },
    dismissPopup: () => {
      keyboard.dismissPopup();
    },
    canSubmit: () => !gate.current.locked && !gate.current.machineBusy,
    submit: (accelerated) => {
      const g = gate.current;

      if (accelerated && g.canSteerQueue) {
        keyboard.steerQueue();
        return;
      }
      if (g.uploadsPending) {
        g.showToast(g.t("file.stillUploading"));
        return;
      }
      keyboard.submit(
        resolveSubmitMode(
          g.busyEnter,
          g.running,
          accelerated ? "accelerated" : "enter",
          g.steeringAvailable,
        ),
      );
    },
    intakeFiles: (files) => {
      gate.current.intakeFiles(files);
    },
    pasteText: (text) => {
      if (gate.current.machineBusy || gate.current.locked) return;
      keyboard.paste(text);
    },
    clipboardUri: (path) => keyboard.clipboardUri(path),
  });
}

export function keepDraftFocus(
  event: MouseEvent<HTMLButtonElement>,
  editor: LexicalEditor | null,
): void {
  event.preventDefault();
  editor?.getRootElement()?.focus({ preventScroll: true });
}
