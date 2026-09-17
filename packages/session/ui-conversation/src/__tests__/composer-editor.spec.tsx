// @vitest-environment jsdom
// fork 差异点（docs/debt/0001）：chip 插入路径删除后，检测偏移上的文本替换与三视图投影
// 就是 composer 的唯一编辑面。
import type { LexicalEditor } from "lexical";
import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { afterEach, describe, expect, it } from "vitest";
import { $createReferenceChipNode } from "../client/input/editor/chip-node.tsx";
import {
  $composerLayout,
  ATOMIC_CHAR,
  detectOffsetOfClipboardOffset,
} from "../client/input/editor/projection.ts";
import { $replaceDetectSpanWithText, $selectDetectSpan } from "../client/input/editor/span-map.ts";
import {
  SESSION_REF,
  disposeAll,
  editorOf,
  idAssigner,
  projectionOf,
  seedText,
} from "./composer-editor-harness.ts";

afterEach(disposeAll);

describe("$projectComposer: 文本 / 检测 / 引用三视图", () => {
  it("空文档投影出空文本且没有引用出现项", () => {
    const editor = editorOf();
    expect(projectionOf(editor)).toMatchObject({
      detectText: "",
      clipboardText: "",
      occurrences: [],
      caret: null,
      selection: null,
    });
  });

  it("段落间隔与行内换行在两种视图里都是换行", () => {
    const editor = editorOf();
    editor.update(
      () => {
        const first = $createParagraphNode();
        first.append($createTextNode("a"), $createLineBreakNode(), $createTextNode("b"));
        const second = $createParagraphNode();
        second.append($createTextNode("c"));
        $getRoot().append(first, second);
      },
      { discrete: true },
    );
    const projection = projectionOf(editor);
    expect(projection.detectText).toBe("a\nb\nc");
    expect(projection.clipboardText).toBe("a\nb\nc");
  });

  it("引用在检测视图里是一个原子字符，在剪贴板视图里是完整引用文本", () => {
    const editor = editorOf();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode("ask "),
            $createReferenceChipNode(SESSION_REF),
            $createTextNode(" now"),
          ),
        );
      },
      { discrete: true },
    );
    const projection = projectionOf(editor);
    expect(projection.detectText).toBe(`ask ${ATOMIC_CHAR} now`);
    expect(projection.clipboardText).toBe(`ask ${SESSION_REF.clipboardText} now`);
    expect(projection.occurrences).toEqual([
      {
        occurrenceId: 1,
        source: SESSION_REF.source,
        ref: SESSION_REF.ref,
        offset: 4,
        length: SESSION_REF.clipboardText.length,
        label: SESSION_REF.label,
        appearance: SESSION_REF.appearance,
        clipboardText: SESSION_REF.clipboardText,
      },
    ]);
  });

  it("同一节点在多轮投影里保持同一个出现项 id", () => {
    const editor = editorOf();
    const idOf = idAssigner();
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createReferenceChipNode(SESSION_REF)));
      },
      { discrete: true },
    );
    expect(projectionOf(editor, idOf).occurrences[0]?.occurrenceId).toBe(1);
    expect(projectionOf(editor, idOf).occurrences[0]?.occurrenceId).toBe(1);
  });

  it("无效引用在出现项里带上失效位", () => {
    const editor = editorOf();
    editor.update(
      () => {
        const chip = $createReferenceChipNode(SESSION_REF);
        chip.setInvalid(true);
        $getRoot().append($createParagraphNode().append(chip));
      },
      { discrete: true },
    );
    expect(projectionOf(editor).occurrences[0]?.invalid).toBe(true);
  });
});

describe("$replaceDetectSpanWithText: 检测偏移上的文本替换", () => {
  function replace(editor: LexicalEditor, start: number, end: number, text: string): boolean {
    let applied = false;
    editor.update(
      () => {
        applied = $replaceDetectSpanWithText({ start, end }, text);
      },
      { discrete: true },
    );
    return applied;
  }

  it("替换一段区间为文本并把光标放在替换结果之后", () => {
    const editor = editorOf();
    seedText(editor, "hello world");
    expect(replace(editor, 6, 11, "there")).toBe(true);

    expect(projectionOf(editor)).toMatchObject({ clipboardText: "hello there", caret: 11 });
  });

  it("空替换文本删除这段区间（消费令牌的形状）", () => {
    const editor = editorOf();
    seedText(editor, "/goal keep");
    expect(replace(editor, 0, 6, "")).toBe(true);

    expect(projectionOf(editor).clipboardText).toBe("keep");
  });

  it("覆盖引用的区间替换会一并移除该引用出现项", () => {
    const editor = editorOf();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode("ask "),
            $createReferenceChipNode(SESSION_REF),
          ),
        );
      },
      { discrete: true },
    );
    expect(replace(editor, 0, 5, "file:src/a.ts")).toBe(true);

    const projection = projectionOf(editor);
    expect(projection.clipboardText).toBe("file:src/a.ts");
    expect(projection.occurrences).toEqual([]);
  });

  it("跨段落的替换把两段并成一段", () => {
    const editor = editorOf();
    editor.update(
      () => {
        const first = $createParagraphNode();
        first.append($createTextNode("one"));
        const second = $createParagraphNode();
        second.append($createTextNode("two"));
        $getRoot().append(first, second);
      },
      { discrete: true },
    );
    expect(replace(editor, 2, 5, "-")).toBe(true);

    expect(projectionOf(editor).clipboardText).toBe("on-wo");
    expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(1);
  });

  it("越界、倒置与负偏移的区间被拒绝且不改动文档", () => {
    const editor = editorOf();
    seedText(editor, "abc");
    expect(replace(editor, 0, 99, "x")).toBe(false);
    expect(replace(editor, 2, 1, "x")).toBe(false);
    expect(replace(editor, -1, 1, "x")).toBe(false);

    expect(projectionOf(editor).clipboardText).toBe("abc");
  });

  it("空文档上的插入长出第一段", () => {
    const editor = editorOf();
    expect(replace(editor, 0, 0, "seed")).toBe(true);

    expect(projectionOf(editor).clipboardText).toBe("seed");
  });

  it("$selectDetectSpan 报告区间是否落在文档范围内", () => {
    const editor = editorOf();
    seedText(editor, "abc");
    editor.update(
      () => {
        expect($selectDetectSpan({ start: 1, end: 2 })).toBe(true);
        expect($selectDetectSpan({ start: 0, end: 9 })).toBe(false);
      },
      { discrete: true },
    );
  });
});

describe("detectOffsetOfClipboardOffset: 剪贴板偏移映射回检测偏移", () => {
  it("引用内部与其边界都映射到引用在检测视图里的位置", () => {
    const editor = editorOf();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode("a"),
            $createReferenceChipNode({ ...SESSION_REF, clipboardText: "xy" }),
            $createTextNode("b"),
          ),
        );
      },
      { discrete: true },
    );
    // 剪贴板视图 "axyb" -> 检测视图 "a<atomic>b"
    editor.getEditorState().read(() => {
      const layout = $composerLayout();
      expect(detectOffsetOfClipboardOffset(layout, 0)).toBe(0);
      expect(detectOffsetOfClipboardOffset(layout, 1)).toBe(1);
      expect(detectOffsetOfClipboardOffset(layout, 2)).toBe(2);
      expect(detectOffsetOfClipboardOffset(layout, 3)).toBe(2);
      expect(detectOffsetOfClipboardOffset(layout, 4)).toBe(3);
    });
  });

  it("超过文档长度的偏移落在检测文本末尾", () => {
    const editor = editorOf();
    seedText(editor, "ab");
    editor.getEditorState().read(() => {
      expect(detectOffsetOfClipboardOffset($composerLayout(), 99)).toBe(2);
    });
  });
});
