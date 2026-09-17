import { activeAtToken } from "@deepseek-ai/dsh-file-reference/grammar";
import type { TriggerChar } from "../types.ts";
import type { DetectTrigger } from "./contract.ts";

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;

function boundaryOk(draft: string, index: number, char: TriggerChar): boolean {
  if (index === 0) return true;
  const prev = draft.charAt(index - 1);
  if (WHITESPACE.test(prev)) return true;
  if (WORD_CHAR.test(prev)) return false;
  if (char === "/") {
    if (prev === "/") return false;
    if (prev === ":" && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
  }
  return true;
}

export const detectTrigger: DetectTrigger = (draft, caret, guard) => {
  if (guard.tier === "frozen") return null;
  const at = activeAtToken(draft, caret);
  if (at !== undefined) {
    const start = caret - at.prefix.length;
    return {
      trigger: "@",
      query: at.query,
      quoted: at.quoted,
      position: draft.search(/\S/) === start ? "leading" : "inline",
      span: { start, end: caret, draftRev: 0 },
    };
  }
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch !== "/") continue;
    if (guard.tier === "claimed") continue;
    if (!boundaryOk(draft, i, ch)) continue;
    return {
      trigger: ch,
      query: draft.slice(i + 1, caret),
      quoted: false,
      position: draft.search(/\S/) === i ? "leading" : "inline",
      span: { start: i, end: caret, draftRev: 0 },
    };
  }
  return null;
};
