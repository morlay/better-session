import type { RangeSelection } from "lexical";
import { $createRangeSelection, $getRoot, $setSelection } from "lexical";
import type { ComposerLayout } from "./projection.ts";
import { $composerLayout } from "./projection.ts";

export interface DetectSpan {
  readonly start: number;
  readonly end: number;
}

interface ResolvedPoint {
  readonly key: string;
  readonly offset: number;
  readonly type: "text" | "element";
}

function resolvePoint(layout: ComposerLayout, offset: number): ResolvedPoint | null {
  if (offset < 0 || offset > layout.detectLength) return null;
  for (const segment of layout.segments) {
    if (offset >= segment.detectStart + segment.detectLength) continue;
    if (segment.kind === "text" && segment.node !== null) {
      return { key: segment.node.getKey(), offset: offset - segment.detectStart, type: "text" };
    }
    if (segment.kind === "gap" && segment.gapBetween !== undefined) {
      const before = segment.gapBetween.before;
      return { key: before, offset: layout.children.get(before)?.length ?? 0, type: "element" };
    }

    if (segment.node === null) return null;
    const element = segment.node.getParent();

    if (element === null) return null;
    return { key: element.getKey(), offset: segment.node.getIndexWithinParent(), type: "element" };
  }

  const blocks = $getRoot().getChildren();
  const last = blocks[blocks.length - 1];
  if (last === undefined) return { key: $getRoot().getKey(), offset: 0, type: "element" };
  return {
    key: last.getKey(),
    offset: layout.children.get(last.getKey())?.length ?? 0,
    type: "element",
  };
}

function selectSpan(layout: ComposerLayout, span: DetectSpan): RangeSelection | null {
  if (span.start < 0 || span.start > span.end || span.end > layout.detectLength) return null;
  const anchor = resolvePoint(layout, span.start);
  const focus = resolvePoint(layout, span.end);

  if (anchor === null || focus === null) return null;
  const selection = $createRangeSelection();
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(selection);
  return selection;
}

export function $selectDetectSpan(span: DetectSpan): boolean {
  return selectSpan($composerLayout(), span) !== null;
}

export function $replaceDetectSpanWithText(span: DetectSpan, text: string): boolean {
  const selection = selectSpan($composerLayout(), span);
  if (selection === null) return false;
  if (text === "" && !selection.isCollapsed()) selection.removeText();
  else selection.insertText(text);
  return true;
}
