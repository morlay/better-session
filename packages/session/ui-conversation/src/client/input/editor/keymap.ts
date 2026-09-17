import type { LexicalEditor } from "lexical";
import {
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_SPACE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
} from "lexical";
import { mergeRegister } from "@lexical/utils";
import type { ArbitrateKey, ArbitrateOutcome } from "../../contract/draft-editor.ts";
import { clipboardSources, pasteTextOf, resolveClipboardData } from "../clipboard-resource.ts";

export interface ComposerKeymapHandlers {
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome;

  space(): boolean;

  dismissPopup(): void;

  canSubmit(): boolean;

  submit(accelerated: boolean): void;

  intakeFiles(files: readonly File[]): void;

  pasteText(text: string): void;

  clipboardUri(path: string): string;
}

function isComposingEvent(event: KeyboardEvent, recentlyComposing: () => boolean): boolean {
  return event.isComposing || event.keyCode === 229 || recentlyComposing();
}

export function registerComposerKeymap(
  editor: LexicalEditor,
  handlers: ComposerKeymapHandlers,
): () => void {
  let composing = false;
  let composingUntil = 0;
  let rootElement: HTMLElement | null = null;
  const syncComposition = (): void => {
    rootElement?.toggleAttribute("data-composer-composing", composing || editor.isComposing());
  };
  const onCompositionStart = (): void => {
    composing = true;
    syncComposition();
  };
  const onCompositionEnd = (): void => {
    composing = false;
    composingUntil = Date.now() + 10;

    editor.update(() => {}, { onUpdate: syncComposition });
  };
  const recentlyComposing = (): boolean => composing || Date.now() < composingUntil;

  const arrow =
    (key: ArbitrateKey) =>
    (event: KeyboardEvent | null): boolean => {
      const inComposition = event !== null && isComposingEvent(event, recentlyComposing);
      if (handlers.arbitrate(key, inComposition) !== "pass") {
        event?.preventDefault();
        return true;
      }
      return false;
    };

  return mergeRegister(
    editor.registerRootListener((root, prevRoot) => {
      prevRoot?.removeEventListener("compositionstart", onCompositionStart);
      prevRoot?.removeEventListener("compositionend", onCompositionEnd);
      prevRoot?.removeAttribute("data-composer-composing");
      composing = false;
      composingUntil = 0;
      rootElement = root;
      root?.addEventListener("compositionstart", onCompositionStart);
      root?.addEventListener("compositionend", onCompositionEnd);
      syncComposition();
    }),
    editor.registerUpdateListener(syncComposition),
    editor.registerCommand(KEY_ARROW_UP_COMMAND, arrow("up"), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ARROW_DOWN_COMMAND, arrow("down"), COMMAND_PRIORITY_CRITICAL),

    editor.registerCommand(KEY_TAB_COMMAND, arrow("tab"), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        handlers.dismissPopup();
        if (
          handlers.arbitrate("escape", isComposingEvent(event, recentlyComposing)) === "consumed"
        ) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      KEY_SPACE_COMMAND,
      (event) => {
        if (isComposingEvent(event, recentlyComposing)) return false;
        const consumed = handlers.space();
        if (consumed) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey === true) return false;
        if (event !== null && isComposingEvent(event, recentlyComposing)) {
          return true;
        }

        if (handlers.arbitrate("enter", false) !== "pass") {
          event?.preventDefault();
          return true;
        }
        event?.preventDefault();
        if (event?.repeat === true) return true;
        if (!handlers.canSubmit()) return true;
        handlers.submit(event?.ctrlKey === true || event?.metaKey === true);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = (event as ClipboardEvent).clipboardData ?? null;
        if (clipboardData === null) return false;
        const files = Array.from(clipboardData.items)
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (files.length > 0) handlers.intakeFiles(files);
        const text = clipboardData.getData("text/plain");
        if (text === "") {
          if (files.length === 0) return false;
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        const sources = clipboardSources(resolveClipboardData(clipboardData));

        const pasted = pasteTextOf(sources, (path) => handlers.clipboardUri(path));
        handlers.pasteText(pasted ?? text);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
}
