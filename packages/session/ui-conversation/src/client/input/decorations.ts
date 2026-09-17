export interface TextRefRange {
  readonly start: number;
  readonly end: number;
  readonly trigger: "/" | "@";
}

const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g;
const FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g;

const SLASH_TOKEN_END_RE = /^(?:\s|$)/;

export function scanTextRefs(
  draft: string,
  lexicon: ReadonlyMap<"/" | "@", readonly string[]>,
): TextRefRange[] {
  if (draft === "") return [];
  const out: TextRefRange[] = [];
  if (lexicon.size > 0) {
    TEXT_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEXT_REF_RE.exec(draft)) !== null) {
      const trigger = m[2] as "/" | "@";
      const name = m[3] ?? "";
      if (trigger === "/" && !SLASH_TOKEN_END_RE.test(draft.slice(m.index + m[0].length))) continue;
      if (lexicon.get(trigger)?.includes(name)) {
        const start = m.index + (m[1]?.length ?? 0);
        out.push({ start, end: start + 1 + name.length, trigger });
      }
    }
  }
  FOLDER_REF_RE.lastIndex = 0;
  let folder: RegExpExecArray | null;
  while ((folder = FOLDER_REF_RE.exec(draft)) !== null) {
    const token = folder[2] ?? "";
    const start = folder.index + (folder[1]?.length ?? 0);
    const end = start + token.length;
    if (!out.some((range) => range.start < end && range.end > start)) {
      out.push({ start, end, trigger: "@" });
    }
  }
  return out.sort((left, right) => left.start - right.start);
}
