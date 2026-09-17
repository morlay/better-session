import type { ReferenceInsert } from "../contract/draft-editor.ts";
import { formatReference, type Reference } from "@morlay/dsh-client-ui-primitives/client";

const AT_PATH = /^@(?:"([^"\n]*)"|([^\s]+))$/u;
const SKILL_TEXT = /^\/([\w-]+)\s*$/u;

function fileReferenceOf(insert: ReferenceInsert): Reference | undefined {
  if (insert.appearance !== "file" && insert.appearance !== "folder") return undefined;
  const matched = AT_PATH.exec(insert.ref);
  const path = matched?.[1] ?? matched?.[2];
  if (path === undefined) return undefined;
  return { protocol: "file", path };
}

export function referenceTextOf(insert: ReferenceInsert): ReferenceInsert {
  const reference = fileReferenceOf(insert);
  return reference === undefined
    ? insert
    : { ...insert, clipboardText: formatReference(reference) };
}

export function insertTextOf(text: string): string {
  const name = SKILL_TEXT.exec(text)?.[1];
  if (name === undefined) return text;
  const tail = text.endsWith(" ") ? " " : "";
  return `${formatReference({ protocol: "skill", path: name })}${tail}`;
}
