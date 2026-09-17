// 引用 → 官方 markdown 渲染器的 chip。
//
// 解析与渲染分离：reference.ts 负责解析成统一结构的引用，这里只做「引用 → 官方渲染器
// 认得的形态」这一步转换，渲染本身完全交给官方 MarkdownText（不 fork 渲染器）。
//
// 转换规则：本地引用（file / skill / dsh-session …，见 isLocalReference）的原文切片
// 换成 inline code——官方唯一的 chip 钩子是 fileMentions，它只认 inline code，产出
// icon + 文本的 chip，点击走 actions。http(s) / mailto 这类外部地址保持 link 原文，
// 官方渲染器照常出锚点。
//
// inline code 里的文本是**省略 protocol 的显示文本**（图标已经表示协议：file 走文件图标，
// label 有就用 label）；判定不靠文本形态，而是本次转换产出的 value → Reference 映射，
// 因此 `code-review` 这种没有路径特征的 skill 也能稳定成 chip、而普通 inline code 不会。

import { memo, useMemo } from "react";
import { MarkdownText } from "./client/markdown-text.ts";
import type {
  MarkdownFileMentions,
  MarkdownLabels,
  MarkdownPathImages,
} from "./client/markdown-text.ts";
import {
  findReferences,
  formatReference,
  isLocalReference,
  parseReferenceToken,
} from "./reference.ts";
import type { Reference } from "./reference.ts";

// chip 的点击目标：file → openFile(path)，skill → openSkill(name)。
// 没有 actions 时 chip 照旧渲染，只是点击无效果。
export interface ReferenceActions {
  readonly openFile: (path: string) => void;
  readonly openSkill: (name: string) => void;
}

export interface ReferenceMarkdownProps {
  readonly text: string;
  readonly labels: MarkdownLabels;
  readonly actions?: ReferenceActions | undefined;
  readonly streaming?: boolean | undefined;
  // 透传给官方渲染器：图片目标是本地路径时的改写词表（替换 MarkdownText 时不丢这个能力）。
  readonly pathImages?: MarkdownPathImages | undefined;
}

// 把引用接进官方 fileMentions 钩子：value 是 chip 上的显示文本，title 是完整引用。
// 不是本次转换产出的引用（普通 inline code）返回 undefined，渲染器按普通 code 处理。
export function referenceMentions(
  actions?: ReferenceActions,
  tokens?: ReadonlyMap<string, Reference>,
): MarkdownFileMentions {
  return {
    resolve: (value) => {
      const reference = tokens?.get(value) ?? parseReferenceToken(value);
      if (reference === undefined) return undefined;
      return {
        label: value,
        title: formatReference(reference),
        open: () => {
          openReference(reference, actions);
        },
      };
    },
  };
}

// 引用感知的 markdown 渲染。text 每帧变化时只重跑一次「引用 → 显示文本」的转换（命中引用才
// 改文本），解析与渲染的增量缓存仍由官方 MarkdownText 负责。
export const ReferenceMarkdown = memo(function ReferenceMarkdown({
  text,
  labels,
  actions,
  streaming = false,
  pathImages,
}: ReferenceMarkdownProps) {
  const { source, tokens } = useMemo(() => tokenizeReferences(text), [text]);
  // actions / tokens 的 identity 决定 mentions 的 identity：官方 MarkdownText 在 fileMentions
  // 上 memo（流式期间换 identity 会丢渲染缓存），所以按两者记忆。
  const mentions = useMemo(() => referenceMentions(actions, tokens), [actions, tokens]);
  return (
    <MarkdownText
      text={source}
      streaming={streaming}
      labels={labels}
      fileMentions={mentions}
      pathImages={pathImages}
    />
  );
});

// chip 上的显示文本：图标已经表示 protocol，所以省略 scheme——有 label（markdown link /
// mention）就用 label，否则用 path（带行号 fragment）。反引号会截断 inline code，替换掉。
function displayTextOf(reference: Reference): string {
  const base = reference.title ?? `${reference.path ?? ""}${rangeOf(reference)}`;
  return base.replaceAll("`", "'");
}

function rangeOf(reference: Reference): string {
  if (reference.lineStart === undefined) return "";
  const column = reference.column === undefined ? "" : `C${String(reference.column)}`;
  return reference.lineEnd === undefined
    ? `#L${String(reference.lineStart)}${column}`
    : `#L${String(reference.lineStart)}${column}-L${String(reference.lineEnd)}`;
}

// 本地引用的原文切片 → inline code；外部地址原样留下。引用不会嵌套（解析器保证），
// 这里仍按 offset 顺序跳过被前一个切片覆盖的引用。
// 边界：引用紧贴相邻 inline code 的反引号（`` `x`file:y ``）时两个 code span 会并成一个，
// 这种写法退化成普通 code——与上一版包反引号的行为一致。
function tokenizeReferences(text: string): {
  readonly source: string;
  readonly tokens: Map<string, Reference>;
} {
  const tokens = new Map<string, Reference>();
  let out = "";
  let cursor = 0;
  for (const span of findReferences(text)) {
    if (!isLocalReference(span.reference) || span.start < cursor) continue;
    const display = displayTextOf(span.reference);
    tokens.set(display, span.reference);
    out += `${text.slice(cursor, span.start)}\`${display}\``;
    cursor = span.end;
  }
  return { source: cursor === 0 ? text : out + text.slice(cursor), tokens };
}

// skill 认名字、file 认路径；其它 protocol（dsh-session 等）渲染成 chip 但还没有点击目标。
function openReference(reference: Reference, actions: ReferenceActions | undefined): void {
  const path = reference.path;
  if (actions === undefined || path === undefined) return;
  if (reference.protocol === "skill") {
    actions.openSkill(path);
    return;
  }
  if (reference.protocol === "file") actions.openFile(path);
}
