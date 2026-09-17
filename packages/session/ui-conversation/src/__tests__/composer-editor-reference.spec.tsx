// @vitest-environment jsdom
// 引用的编辑器交互：目录到齐后令牌实体化、被指令认领时让位给令牌高亮、点击把引用交回宿主。
import { registerPlainText } from "@lexical/plain-text";
import type { LexicalEditor, NodeKey } from "lexical";
import { $createParagraphNode, $createTextNode, $getRoot, $isTextNode } from "lexical";
import type { ParagraphNode } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $createReferenceChipNode, ReferenceChipNode } from "../client/input/editor/chip-node.tsx";
import { registerClaimDecoration } from "../client/input/editor/claim-decor.ts";
import { registerReferenceActivation } from "../client/input/editor/reference-activation.ts";
import {
  registerTextRefDecoration,
  rescanTextRefs,
  TextRefNode,
} from "../client/input/editor/text-ref.ts";
import {
  EMPTY_LEXICON,
  LEXICON,
  SESSION_REF,
  disposeAll,
  domEditor,
  editorOf,
  projectionOf,
  seedText,
  track,
} from "./composer-editor-harness.ts";

afterEach(disposeAll);

function firstLeaf(editor: LexicalEditor): { type: string; text: string; style: string } | null {
  return editor.getEditorState().read(() => {
    const first = ($getRoot().getFirstChild() as ParagraphNode).getFirstChild();
    if (first === null) return null;
    return {
      type: first.getType(),
      text: first.getTextContent(),
      style: $isTextNode(first) ? first.getStyle() : "",
    };
  });
}

function leaves(editor: LexicalEditor): { text: string; style: string }[] {
  return editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChild() as ParagraphNode;
    return paragraph.getChildren().map((child) => ({
      text: child.getTextContent(),
      style: $isTextNode(child) ? child.getStyle() : "",
    }));
  });
}

function textRefEditor(
  token: () => string | null,
  lexicon: () => ReadonlyMap<"/" | "@", readonly string[]>,
): LexicalEditor {
  const editor = editorOf();
  track(registerTextRefDecoration(editor, lexicon, token));
  return editor;
}

describe("引用实体化（text-ref）", () => {
  it("目录里已有的令牌升级成引用实体", () => {
    const editor = textRefEditor(
      () => null,
      () => LEXICON,
    );
    seedText(editor, "/deploy now");

    expect(firstLeaf(editor)).toMatchObject({ type: "composer-text-ref", text: "/deploy" });
  });

  it("实体化的令牌在编辑器里挂上引用标记，普通文本没有", () => {
    const { editor, root } = domEditor("textref-spec");
    track(
      registerTextRefDecoration(
        editor,
        () => LEXICON,
        () => null,
      ),
    );
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode("/deploy now")));
      },
      { discrete: true },
    );

    expect(root.querySelector("[data-composer-text-ref]")?.textContent).toBe("/deploy");
    expect(root.textContent).toBe("/deploy now");
  });

  it("目录外的令牌保持纯文本", () => {
    const editor = textRefEditor(
      () => null,
      () => LEXICON,
    );
    seedText(editor, "/unknown now");

    expect(firstLeaf(editor)).toMatchObject({ type: "text", text: "/unknown now" });
  });

  it("同一令牌被指令认领时不被实体化", () => {
    const editor = textRefEditor(
      () => "/deploy",
      () => LEXICON,
    );
    seedText(editor, "/deploy now");

    expect(firstLeaf(editor)?.type).toBe("text");
  });

  it("目录在输入之后到齐时重新扫描让令牌实体化", () => {
    let lexicon: ReadonlyMap<"/" | "@", readonly string[]> = EMPTY_LEXICON;
    const editor = textRefEditor(
      () => null,
      () => lexicon,
    );
    seedText(editor, "/deploy now");
    expect(firstLeaf(editor)?.type).toBe("text");

    lexicon = LEXICON;
    editor.update(
      () => {
        rescanTextRefs(editor);
      },
      { discrete: true },
    );
    expect(firstLeaf(editor)?.type).toBe("composer-text-ref");
  });
});

describe("指令认领高亮（claim-decor）", () => {
  it("认领中的令牌与后续参数分成两个文本节点，只有令牌被标记", () => {
    const editor = editorOf();
    track(registerClaimDecoration(editor, () => "/goal "));
    seedText(editor, "/goal 上线");

    const parts = leaves(editor);
    expect(parts.map((part) => part.text)).toEqual(["/goal ", "上线"]);
    expect(parts[0]?.style).not.toBe("");
    expect(parts[1]?.style).toBe("");
  });

  it("令牌释放后标记消失", () => {
    let token: string | null = "/goal ";
    const editor = editorOf();
    track(registerClaimDecoration(editor, () => token));
    seedText(editor, "/goal 上线");
    expect(leaves(editor)[0]?.style).not.toBe("");

    token = null;
    editor.update(
      () => {
        ($getRoot().getFirstChild() as ParagraphNode).getFirstChild()?.markDirty();
      },
      { discrete: true },
    );
    expect(leaves(editor).every((part) => part.style === "")).toBe(true);
  });
});

describe("引用点击激活", () => {
  function clickOn(editor: LexicalEditor, key: NodeKey, detail = 1): void {
    editor.getElementByKey(key)?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  }

  it("点击引用芯片把它交回宿主打开，且不改动草稿", () => {
    const { editor } = domEditor("click-spec");
    const open = vi.fn(() => true);
    track(registerReferenceActivation(editor, open));
    let chip = null as ReferenceChipNode | null;
    editor.update(
      () => {
        chip = $createReferenceChipNode({
          ...SESSION_REF,
          appearance: "file",
          clipboardText: "file:a.md",
        });
        $getRoot().append($createParagraphNode().append(chip, $createTextNode(" /review")));
      },
      { discrete: true },
    );
    const chipNode = chip as ReferenceChipNode | null;
    if (chipNode === null) throw new Error("chip node missing");

    clickOn(editor, chipNode.getKey());

    expect(open).toHaveBeenLastCalledWith(SESSION_REF.source, {
      ref: SESSION_REF.ref,
      appearance: "file",
    });
    expect(projectionOf(editor).clipboardText).toBe("file:a.md /review");
  });

  it("点击文本引用不带来源地交回宿主打开，双击的第二次点击不再打开", () => {
    const { editor } = domEditor("click-spec");
    track(registerPlainText(editor));
    const open = vi.fn(() => true);
    track(registerReferenceActivation(editor, open));
    let text = null as TextRefNode | null;
    editor.update(
      () => {
        text = new TextRefNode("/review");
        $getRoot().append($createParagraphNode().append(text));
      },
      { discrete: true },
    );
    const textNode = text as TextRefNode | null;
    if (textNode === null) throw new Error("text node missing");

    clickOn(editor, textNode.getKey());
    expect(open).toHaveBeenLastCalledWith(undefined, { ref: "/review" });

    clickOn(editor, textNode.getKey(), 2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("失效引用点击不再打开", () => {
    const { editor } = domEditor("click-spec");
    const open = vi.fn(() => true);
    track(registerReferenceActivation(editor, open));
    let chip = null as ReferenceChipNode | null;
    editor.update(
      () => {
        chip = $createReferenceChipNode({ ...SESSION_REF, clipboardText: "file:a.md" });
        $getRoot().append($createParagraphNode().append(chip));
      },
      { discrete: true },
    );
    const chipNode = chip as ReferenceChipNode | null;
    if (chipNode === null) throw new Error("chip node missing");
    editor.update(
      () => {
        chipNode.setInvalid(true);
      },
      { discrete: true },
    );

    clickOn(editor, chipNode.getKey());

    expect(open).not.toHaveBeenCalled();
  });
});
