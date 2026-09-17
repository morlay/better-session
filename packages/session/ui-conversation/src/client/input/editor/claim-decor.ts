import type { LexicalEditor, TextNode as TextNodeType } from "lexical";
import { $getRoot, $isElementNode, $isTextNode, TextNode } from "lexical";

const TOKEN_STYLE = "color: var(--dsw-alias-state-warn-label)";

function firstTextLeaf(): TextNodeType | null {
  const block = $getRoot().getFirstChild();
  if (!$isElementNode(block)) return null;
  const leaf = block.getFirstChild();
  return $isTextNode(leaf) ? leaf : null;
}

export function registerClaimDecoration(
  editor: LexicalEditor,
  activeToken: () => string | null,
): () => void {
  return editor.registerNodeTransform(TextNode, (node) => {
    const first = firstTextLeaf();
    if (first === null || node.getKey() !== first.getKey()) {
      if (node.getStyle() === TOKEN_STYLE) node.setStyle("");
      return;
    }
    const text = node.getTextContent();
    const active = activeToken();
    const token = text === active?.trimEnd() ? text : active;
    if (token === null || !text.startsWith(token)) {
      if (node.getStyle() === TOKEN_STYLE) node.setStyle("");
      return;
    }
    if (text.length > token.length) {
      const [tokenNode] = node.splitText(token.length);
      if (tokenNode !== undefined && tokenNode.getStyle() !== TOKEN_STYLE)
        tokenNode.setStyle(TOKEN_STYLE);
      return;
    }
    if (node.getStyle() !== TOKEN_STYLE) node.setStyle(TOKEN_STYLE);
  });
}

export function refreshClaimDecoration(editor: LexicalEditor): void {
  editor.update(() => {
    firstTextLeaf()?.markDirty();
  });
}
