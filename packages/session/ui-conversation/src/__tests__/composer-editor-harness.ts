// composer 编辑器测试的共享装配：headless 编辑器（纯模型）与真实 DOM 编辑器（节点元素 / 点击）。
import { createHeadlessEditor } from "@lexical/headless";
import type { LexicalEditor, NodeKey } from "lexical";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { ReferenceChipNode } from "../client/input/editor/chip-node.tsx";
import { $projectComposer } from "../client/input/editor/projection.ts";
import { TextRefNode } from "../client/input/editor/text-ref.ts";

export const SESSION_REF = {
  source: "reference",
  ref: "@[Research](dsh-session:InNvdXJjZSI)",
  label: "Research",
  appearance: "session" as const,
  clipboardText: "@[Research](dsh-session:InNvdXJjZSI)",
};

export const LEXICON: ReadonlyMap<"/" | "@", readonly string[]> = new Map([["/", ["deploy"]]]);
export const EMPTY_LEXICON: ReadonlyMap<"/" | "@", readonly string[]> = new Map();

const NODES = [ReferenceChipNode, TextRefNode];

const cleanups: (() => void)[] = [];

export function disposeAll(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

export function track(cleanup: () => void): void {
  cleanups.push(cleanup);
}

export function editorOf(): LexicalEditor {
  return createHeadlessEditor({
    namespace: "composer-spec",
    nodes: NODES,
    onError: (error) => {
      throw error;
    },
  });
}

/** 挂到真实 DOM 的编辑器：节点元素可查询，点击命令可派发。 */
export function domEditor(namespace: string): { editor: LexicalEditor; root: HTMLElement } {
  const editor = createEditor({
    namespace,
    nodes: NODES,
    onError: (error) => {
      throw error;
    },
  });
  const root = document.createElement("div");
  root.contentEditable = "true";
  document.body.append(root);
  editor.setRootElement(root);
  track(() => {
    editor.setRootElement(null);
    root.remove();
  });
  return { editor, root };
}

export function idAssigner(): (key: NodeKey) => number {
  const ids = new Map<NodeKey, number>();
  let seq = 0;
  return (key) => {
    const known = ids.get(key);
    if (known !== undefined) return known;
    seq += 1;
    ids.set(key, seq);
    return seq;
  };
}

export function projectionOf(editor: LexicalEditor, idOf = idAssigner()) {
  return editor.getEditorState().read(() => $projectComposer(idOf));
}

export function seedText(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(text)));
    },
    { discrete: true },
  );
}
