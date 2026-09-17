import type { Nodes, Root } from "mdast";
import type {
  CompileContext,
  Extension as MdastExtension,
  Transform,
} from "mdast-util-from-markdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import {
  asciiAlpha,
  asciiAlphanumeric,
  asciiDigit,
  markdownLineEndingOrSpace,
  unicodePunctuation,
  unicodeWhitespace,
} from "micromark-util-character";
import { gfm } from "micromark-extension-gfm";
import { codes, types } from "micromark-util-symbol";
import type {
  Code,
  Construct,
  Event,
  Extension,
  Previous,
  State,
  Token,
  Tokenizer,
} from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    reference: "reference";
  }
}

export interface Reference {
  readonly protocol: string;

  readonly origin?: string;

  readonly path?: string;

  readonly title?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly column?: number;
}

export interface ReferenceSpan {
  readonly start: number;
  readonly end: number;
  readonly reference: Reference;
}

const DEFAULT_PROTOCOL = "file";

const EXTERNAL_PROTOCOLS: readonly string[] = ["http", "https", "mailto"];

const LINE_FRAGMENT = /^L(\d+)(?:C(\d+))?(?:-L(\d+))?$/u;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/u;

const BARE_PATH = /^([^:]+):(\d+)(?::(\d+))?$/u;

const URI_UNSAFE = /[%#()\s<>"`]/gu;

const PATH_PUNCTUATION: readonly Code[] = [
  codes.slash,
  codes.dash,
  codes.underscore,
  codes.dot,
  codes.plusSign,
  codes.percentSign,
  codes.atSign,
  codes.tilde,
  codes.equalsTo,
];

const TRIGGERS: readonly string[] = [":", "[", "@"];

export function parseReference(value: string, title?: string): Reference | undefined {
  const raw = value.trim();
  if (raw === "") return undefined;
  const matched = SCHEME.exec(raw);
  const protocol = matched === null ? DEFAULT_PROTOCOL : (matched[1] as string).toLowerCase();
  let rest = matched === null ? raw : raw.slice((matched[0] as string).length);

  if (matched !== null && /\s/u.test(rest)) return undefined;
  const fragment = splitLineFragment(rest);
  rest = fragment.head;

  let origin: string | undefined;
  if (rest.startsWith("//")) {
    const end = authorityEnd(rest);
    const authority = rest.slice(2, end);
    if (authority === "") return undefined;
    origin = `${protocol}://${authority}`;
    rest = rest.slice(end).replace(/^\//u, "");
  }

  const decoded = protocol === DEFAULT_PROTOCOL ? decodeUri(rest) : rest;
  if (decoded === undefined || (decoded === "" && origin === undefined)) return undefined;
  return {
    protocol,
    ...(origin === undefined ? {} : { origin }),
    ...(decoded === "" ? {} : { path: decoded }),
    ...(title === undefined || title === "" ? {} : { title }),
    ...fragment.lines,
  };
}

export function parseReferenceToken(value: string): Reference | undefined {
  return SCHEME.test(value) ? parseReference(value) : undefined;
}

export function formatReference(reference: Reference): string {
  const protocol = reference.protocol === "" ? DEFAULT_PROTOCOL : reference.protocol;
  const path = reference.path ?? "";

  if (reference.origin !== undefined) {
    return `${reference.origin}${path === "" ? "" : `/${path}`}`;
  }
  return `${protocol}:${encodeUri(path)}${lineFragmentOf(reference)}`;
}

export function isLocalReference(reference: Reference): boolean {
  return !EXTERNAL_PROTOCOLS.includes(reference.protocol);
}

export function findReferences(text: string): readonly ReferenceSpan[] {
  const spans: ReferenceSpan[] = [];
  if (text === "" || !TRIGGERS.some((trigger) => text.includes(trigger))) return spans;
  collectReferences(parseReferenceDocument(text) as unknown as MarkdownNode, spans);
  return spans;
}

function parseReferenceDocument(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), referenceSyntax()],
    mdastExtensions: [gfmFromMarkdown(), referenceFromMarkdown()],
  });
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: MarkdownPoint; end: MarkdownPoint };
  protocol?: string;
  origin?: string;
  path?: string;
  title?: string;
  lineStart?: number;
  lineEnd?: number;
  column?: number;
}

interface MarkdownPoint {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

function collectReferences(node: MarkdownNode, spans: ReferenceSpan[]): void {
  const position = node.position;
  if (node.type === "reference" && position !== undefined) {
    const reference = referenceOfNode(node);
    if (reference !== undefined) {
      spans.push({ start: position.start.offset, end: position.end.offset, reference });
    }
  }
  for (const child of node.children ?? []) collectReferences(child, spans);
}

function referenceOfNode(node: MarkdownNode): Reference | undefined {
  const protocol = node.protocol;
  if (protocol === undefined) return undefined;
  return {
    protocol,
    ...(node.origin === undefined ? {} : { origin: node.origin }),
    ...(node.path === undefined ? {} : { path: node.path }),
    ...(node.title === undefined ? {} : { title: node.title }),
    ...(node.lineStart === undefined ? {} : { lineStart: node.lineStart }),
    ...(node.lineEnd === undefined ? {} : { lineEnd: node.lineEnd }),
    ...(node.column === undefined ? {} : { column: node.column }),
  };
}

const previousReference: Previous = function (code) {
  return isBoundary(code);
};

const tokenizeReference: Tokenizer = function (effects, ok, nok) {
  const { events } = this;
  let at = false;
  let head = "";

  return start;

  function start(code: Code): State | undefined {
    if (insideLabel(events)) return nok(code);
    effects.enter("reference");
    if (code === codes.atSign) {
      at = true;
      effects.consume(code);
      return afterAt;
    }
    return headStart(code);
  }

  function afterAt(code: Code): State | undefined {
    return asciiAlpha(code) ? headStart(code) : pathStart(code);
  }

  function headStart(code: Code): State | undefined {
    if (!asciiAlpha(code)) return nok(code);
    head = "";
    return headInside(code);
  }

  function headInside(code: Code): State | undefined {
    if (code === null || !asciiAlpha(code)) return afterHead(code);
    head += String.fromCodePoint(code);
    effects.consume(code);
    return headInside;
  }

  function afterHead(code: Code): State | undefined {
    if (code === codes.colon && isKnownScheme(head)) {
      effects.consume(code);
      return head.toLowerCase() === "skill" ? skillInside : fileInside;
    }

    return at ? pathInside(code) : nok(code);
  }

  function pathStart(code: Code): State | undefined {
    if (!isPathCode(code) || code === codes.atSign) return nok(code);
    effects.consume(code);
    return pathInside;
  }

  function fileInside(code: Code): State | undefined {
    if (!isFileCode(code)) return nok(code);
    effects.consume(code);
    return fileRest;
  }

  function fileRest(code: Code): State | undefined {
    if (isFileCode(code)) {
      effects.consume(code);
      return fileRest;
    }
    return finish(code);
  }

  function skillInside(code: Code): State | undefined {
    if (!isSkillCode(code)) return nok(code);
    effects.consume(code);
    return skillRest;
  }

  function skillRest(code: Code): State | undefined {
    if (isSkillCode(code)) {
      effects.consume(code);
      return skillRest;
    }
    return finish(code);
  }

  function pathInside(code: Code): State | undefined {
    if (isPathCode(code) || code === codes.numberSign) {
      effects.consume(code);
      return pathInside;
    }
    if (code !== codes.colon) return isBoundary(code) ? finish(code) : nok(code);
    effects.consume(code);
    return lineInside;
  }

  function lineInside(code: Code): State | undefined {
    if (!asciiDigit(code)) return nok(code);
    effects.consume(code);
    return lineRest;
  }

  function lineRest(code: Code): State | undefined {
    if (asciiDigit(code)) {
      effects.consume(code);
      return lineRest;
    }
    if (code !== codes.colon) return finish(code);
    effects.consume(code);
    return columnInside;
  }

  function columnInside(code: Code): State | undefined {
    if (!asciiDigit(code)) return nok(code);
    effects.consume(code);
    return columnRest;
  }

  function columnRest(code: Code): State | undefined {
    if (asciiDigit(code)) {
      effects.consume(code);
      return columnRest;
    }
    return finish(code);
  }

  function finish(code: Code): State | undefined {
    if (!isBoundary(code)) return nok(code);
    effects.exit("reference");
    return ok(code);
  }
};

const referenceConstruct: Construct = {
  name: "reference",
  previous: previousReference,
  tokenize: tokenizeReference,
};

const referenceSyntaxExtension: Extension = {
  text: {
    [codes.atSign]: referenceConstruct,
    [codes.lowercaseF]: referenceConstruct,
    [codes.uppercaseF]: referenceConstruct,
    [codes.lowercaseS]: referenceConstruct,
    [codes.uppercaseS]: referenceConstruct,
  },
};

export function referenceSyntax(): Extension {
  return referenceSyntaxExtension;
}

function insideLabel(events: readonly Event[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const token = events[index]?.[1];
    if (token === undefined) continue;
    if (
      (token.type === types.labelLink || token.type === types.labelImage) &&
      token._balanced !== true
    ) {
      return true;
    }
  }
  return false;
}

function isBoundary(code: Code): boolean {
  return (
    code === null ||
    markdownLineEndingOrSpace(code) ||
    unicodeWhitespace(code) ||
    unicodePunctuation(code)
  );
}

function isPathCode(code: Code): boolean {
  if (code === null || markdownLineEndingOrSpace(code)) return false;
  if (!unicodePunctuation(code)) return true;
  return PATH_PUNCTUATION.includes(code);
}

function isFileCode(code: Code): boolean {
  return isPathCode(code) || code === codes.numberSign || code === codes.colon;
}

function isSkillCode(code: Code): boolean {
  return (
    asciiAlphanumeric(code) ||
    code === codes.dash ||
    code === codes.underscore ||
    code === codes.dot
  );
}

function enterReference(this: CompileContext, token: Token): undefined {
  this.enter({ type: "reference" } as unknown as Nodes, token);
  return undefined;
}

function exitReference(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1] as unknown as MarkdownNode | undefined;
  const raw = this.sliceSerialize(token);
  const reference = parseBareReference(raw);
  if (node !== undefined) {
    if (reference === undefined) {
      node.type = "text";
      node.value = raw;
    } else {
      Object.assign(node, reference);
    }
  }
  this.exit(token);
  return undefined;
}

const transformLinks: Transform = function (tree) {
  convertLinks(tree as unknown as MarkdownNode);
};

function convertLinks(parent: MarkdownNode): void {
  const children = parent.children;
  if (children === undefined) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if (child.type === "link") {
      const reference = parseReference(child.url ?? "", labelOf(child));
      if (reference !== undefined) {
        children[index] = referenceNodeOf(reference, child, children[index - 1]);
        continue;
      }
    }
    convertLinks(child);
  }
}

function referenceNodeOf(
  reference: Reference,
  link: MarkdownNode,
  previous: MarkdownNode | undefined,
): MarkdownNode {
  const node: MarkdownNode = { type: "reference", ...reference };
  const position = link.position;
  if (position === undefined) return node;
  node.position = startsAfterAt(previous, position.start) ? atStart(position) : position;
  return node;
}

function startsAfterAt(previous: MarkdownNode | undefined, start: MarkdownPoint): boolean {
  if (previous?.type !== "text" || previous.value?.endsWith("@") !== true) return false;
  const position = previous.position;
  if (position === undefined || position.end.offset !== start.offset) return false;

  return position.end.offset - position.start.offset === previous.value.length;
}

function atStart(position: { start: MarkdownPoint; end: MarkdownPoint }): {
  start: MarkdownPoint;
  end: MarkdownPoint;
} {
  return {
    start: {
      line: position.start.line,
      column: position.start.column - 1,
      offset: position.start.offset - 1,
    },
    end: position.end,
  };
}

function labelOf(node: MarkdownNode): string | undefined {
  const label = textOf(node);
  return label === "" ? undefined : label;
}

function textOf(node: MarkdownNode): string {
  if (node.value !== undefined) return node.value;
  let text = "";
  for (const child of node.children ?? []) text += textOf(child);
  return text;
}

function parseBareReference(raw: string): Reference | undefined {
  const body = raw.startsWith("@") ? raw.slice(1) : raw;
  if (body === "") return undefined;
  const scheme = SCHEME.exec(body);
  if (scheme !== null && isKnownScheme(scheme[1] as string)) return parseReference(body);
  const matched = BARE_PATH.exec(body);
  const path = matched?.[1];
  const line = matched?.[2];
  if (path === undefined || line === undefined) return parseReference(body);
  const decoded = decodeUri(path);
  if (decoded === undefined || decoded === "") return undefined;
  const column = matched?.[3];
  return {
    protocol: DEFAULT_PROTOCOL,
    path: decoded,
    lineStart: Number(line),
    ...(column === undefined ? {} : { column: Number(column) }),
  };
}

export function referenceFromMarkdown(): MdastExtension {
  return {
    enter: { reference: enterReference },
    exit: { reference: exitReference },
    transforms: [transformLinks],
  };
}

function isKnownScheme(name: string): boolean {
  const protocol = name.toLowerCase();
  return protocol === "file" || protocol === "skill";
}

function splitLineFragment(value: string): {
  readonly head: string;
  readonly lines: Partial<Pick<Reference, "lineStart" | "lineEnd" | "column">>;
} {
  const hashAt = value.indexOf("#");
  if (hashAt === -1) return { head: value, lines: {} };
  const matched = LINE_FRAGMENT.exec(value.slice(hashAt + 1));
  if (matched === null) return { head: value, lines: {} };
  const lineStart = matched[1];
  if (lineStart === undefined) return { head: value, lines: {} };
  const column = matched[2];
  const lineEnd = matched[3];
  return {
    head: value.slice(0, hashAt),
    lines: {
      lineStart: Number(lineStart),
      ...(column === undefined ? {} : { column: Number(column) }),
      ...(lineEnd === undefined ? {} : { lineEnd: Number(lineEnd) }),
    },
  };
}

function lineFragmentOf(reference: Reference): string {
  if (reference.lineStart === undefined) return "";
  const column = reference.column === undefined ? "" : `C${String(reference.column)}`;
  const lineEnd = reference.lineEnd === undefined ? "" : `-L${String(reference.lineEnd)}`;
  return `#L${String(reference.lineStart)}${column}${lineEnd}`;
}

function authorityEnd(value: string): number {
  for (let index = 2; index < value.length; index += 1) {
    const char = value[index];
    if (char === "/" || char === "?" || char === "#") return index;
  }
  return value.length;
}

function encodeUri(uri: string): string {
  return uri.replace(
    URI_UNSAFE,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function decodeUri(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
