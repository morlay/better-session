import type { ElementNode, LexicalNode, NodeKey, Point } from "lexical";
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
} from "lexical";
import type { Occurrence } from "../../contract/draft-editor.ts";
import { $isReferenceChipNode } from "./chip-node.tsx";

export const ATOMIC_CHAR = "￼";

export interface ComposerSegment {
  readonly kind: "text" | "chip" | "linebreak" | "gap";

  readonly node: LexicalNode | null;
  readonly detectStart: number;
  readonly detectLength: number;
  readonly clipboardStart: number;
  readonly clipboardLength: number;

  readonly gapBetween?: { readonly before: NodeKey; readonly after: NodeKey };
}

export interface ComposerLayout {
  readonly segments: readonly ComposerSegment[];
  readonly detectLength: number;
  readonly detectText: string;
  readonly clipboardText: string;

  readonly byKey: ReadonlyMap<NodeKey, ComposerSegment>;

  readonly children: ReadonlyMap<NodeKey, readonly NodeKey[]>;

  readonly bounds: ReadonlyMap<NodeKey, { readonly start: number; readonly end: number }>;
}

export function $composerLayout(): ComposerLayout {
  const segments: ComposerSegment[] = [];
  const byKey = new Map<NodeKey, ComposerSegment>();
  const children = new Map<NodeKey, readonly NodeKey[]>();
  const bounds = new Map<NodeKey, { start: number; end: number }>();
  let detect = "";
  let clipboard = "";

  const pushLeaf = (
    kind: "text" | "chip" | "linebreak",
    node: LexicalNode,
    detectPiece: string,
    clipboardPiece: string,
  ): void => {
    const segment: ComposerSegment = {
      kind,
      node,
      detectStart: detect.length,
      detectLength: detectPiece.length,
      clipboardStart: clipboard.length,
      clipboardLength: clipboardPiece.length,
    };
    segments.push(segment);
    byKey.set(node.getKey(), segment);
    detect += detectPiece;
    clipboard += clipboardPiece;
  };

  const walkElement = (element: ElementNode): void => {
    const start = detect.length;
    const kids = element.getChildren();
    children.set(
      element.getKey(),
      kids.map((kid) => kid.getKey()),
    );
    for (const kid of kids) {
      if ($isReferenceChipNode(kid)) {
        pushLeaf("chip", kid, ATOMIC_CHAR, kid.getTextContent());
      } else if ($isTextNode(kid)) {
        const text = kid.getTextContent();
        pushLeaf("text", kid, text, text);
      } else if ($isLineBreakNode(kid)) {
        pushLeaf("linebreak", kid, "\n", "\n");
      } else if ($isElementNode(kid)) {
        walkElement(kid);
      }
    }
    bounds.set(element.getKey(), { start, end: detect.length });
  };

  const root = $getRoot();
  const blocks = root.getChildren();
  children.set(
    root.getKey(),
    blocks.map((block) => block.getKey()),
  );
  const rootStart = detect.length;
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    if (index > 0 && previous !== undefined) {
      segments.push({
        kind: "gap",
        node: null,
        detectStart: detect.length,
        detectLength: 1,
        clipboardStart: clipboard.length,
        clipboardLength: 1,
        gapBetween: { before: previous.getKey(), after: block.getKey() },
      });
      detect += "\n";
      clipboard += "\n";
    }
    if ($isElementNode(block)) walkElement(block);
  });
  bounds.set(root.getKey(), { start: rootStart, end: detect.length });

  return {
    segments,
    detectLength: detect.length,
    detectText: detect,
    clipboardText: clipboard,
    byKey,
    children,
    bounds,
  };
}

export function detectOffsetOfClipboardOffset(
  layout: ComposerLayout,
  clipboardOffset: number,
): number {
  for (const segment of layout.segments) {
    const end = segment.clipboardStart + segment.clipboardLength;
    if (clipboardOffset > end) continue;
    if (clipboardOffset === end) return segment.detectStart + segment.detectLength;
    if (segment.kind === "chip") return segment.detectStart + segment.detectLength;
    return segment.detectStart + (clipboardOffset - segment.clipboardStart);
  }
  return layout.detectLength;
}

export interface EditorProjection {
  readonly detectText: string;

  readonly clipboardText: string;

  readonly occurrences: readonly Occurrence[];

  readonly selection: { readonly start: number; readonly end: number } | null;

  readonly caret: number | null;
}

export function $detectOffsetOfPoint(layout: ComposerLayout, point: Point): number | null {
  if (point.type === "text") {
    const segment = layout.byKey.get(point.key);
    return segment === undefined
      ? null
      : segment.detectStart + Math.min(point.offset, segment.detectLength);
  }
  const kids = layout.children.get(point.key);
  const elementBounds = layout.bounds.get(point.key);
  if (kids === undefined || elementBounds === undefined) return null;
  if (point.offset >= kids.length) return elementBounds.end;
  const childKey = kids[point.offset];
  if (childKey === undefined) return elementBounds.end;
  const childSegment = layout.byKey.get(childKey);
  if (childSegment !== undefined) return childSegment.detectStart;
  const childBounds = layout.bounds.get(childKey);
  return childBounds === undefined ? null : childBounds.start;
}

export function $projectComposer(idOf: (key: NodeKey) => number): EditorProjection {
  const layout = $composerLayout();
  const occurrences: Occurrence[] = [];
  for (const segment of layout.segments) {
    if (segment.kind !== "chip" || !$isReferenceChipNode(segment.node)) continue;
    const chip = segment.node;
    occurrences.push({
      occurrenceId: idOf(chip.getKey()),
      source: chip.getSource(),
      ref: chip.getReference(),
      offset: segment.clipboardStart,
      length: segment.clipboardLength,
      label: chip.getLabel(),
      ...(chip.getAppearance() === undefined ? {} : { appearance: chip.getAppearance() }),
      clipboardText: chip.getTextContent(),
      ...(chip.isInvalid() ? { invalid: true } : {}),
    });
  }
  const selection = $getSelection();
  let range: { start: number; end: number } | null = null;
  if ($isRangeSelection(selection)) {
    const anchor = $detectOffsetOfPoint(layout, selection.anchor);
    const focus = $detectOffsetOfPoint(layout, selection.focus);
    if (anchor !== null && focus !== null) {
      range = { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
    }
  }
  return {
    detectText: layout.detectText,
    clipboardText: layout.clipboardText,
    occurrences,
    selection: range,
    caret: range !== null && range.start === range.end ? range.start : null,
  };
}
