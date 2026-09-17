import { styling } from "@morlay/dsh-client-ui-primitives/client";
import type { EditorConfig, LexicalEditor, SerializedTextNode } from "lexical";
import { TextNode } from "lexical";
import { registerLexicalTextEntity } from "@lexical/text";
import { mergeRegister } from "@lexical/utils";
import { $getRoot } from "lexical";
import { scanTextRefs } from "../decorations.ts";
import { styles } from "./composer-editor.styles.ts";

export type SerializedTextRefNode = SerializedTextNode;

export class TextRefNode extends TextNode {
  static override getType(): string {
    return "composer-text-ref";
  }

  static override clone(node: TextRefNode): TextRefNode {
    return new TextRefNode(node.__text, node.__key);
  }

  static override importJSON(json: SerializedTextRefNode): TextRefNode {
    const node = new TextRefNode(json.text);
    node.setFormat(json.format);
    node.setDetail(json.detail);
    node.setMode(json.mode);
    node.setStyle(json.style);
    return node;
  }

  override exportJSON(): SerializedTextRefNode {
    return {
      ...super.exportJSON(),
      type: "composer-text-ref",
    };
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config);

    el.className = [
      el.className,
      styling.className(
        styles.reference,
        styles.textRef,
        this.getTextContent().startsWith("/") && styles.openable,
      ),
    ]
      .filter(Boolean)
      .join(" ");
    el.setAttribute("spellcheck", "false");
    el.setAttribute("data-composer-text-ref", "");
    return el;
  }

  override isTextEntity(): true {
    return true;
  }

  override canInsertTextBefore(): boolean {
    return true;
  }
}

export function registerTextRefDecoration(
  editor: LexicalEditor,
  lexiconOf: () => ReadonlyMap<"/" | "@", readonly string[]>,
  activeToken: () => string | null,
): () => void {
  const getMatch = (text: string): { start: number; end: number } | null => {
    const claim = activeToken();
    for (const range of scanTextRefs(text, lexiconOf())) {
      if (
        claim !== null &&
        range.start === 0 &&
        text.slice(range.start, range.end) === claim.trimEnd()
      )
        continue;
      return { start: range.start, end: range.end };
    }
    return null;
  };
  return mergeRegister(
    ...registerLexicalTextEntity(
      editor,
      getMatch,
      TextRefNode,
      (node) => new TextRefNode(node.getTextContent()),
    ),
  );
}

export function rescanTextRefs(editor: LexicalEditor): void {
  editor.update(() => {
    for (const node of $getRoot().getAllTextNodes()) node.markDirty();
  });
}
