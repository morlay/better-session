import type { UserMessage } from "@deepseek-ai/dsh-session";
import { findReferences, parseReferenceToken } from "@morlay/dsh-client-ui-primitives";
import { fromMarkdown } from "mdast-util-from-markdown";

const SKILL_PROTOCOL = "skill";

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly MarkdownNode[];
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function inlineCodeSkillNames(text: string): string[] {
  const names: string[] = [];
  const root = fromMarkdown(text) as unknown as MarkdownNode;
  walk(root, (node) => {
    if (node.type !== "inlineCode" || node.value === undefined) return;
    const reference = parseReferenceToken(node.value);
    if (reference?.protocol === SKILL_PROTOCOL && reference.path !== undefined) {
      names.push(reference.path);
    }
  });
  return names;
}

export function skillNamesIn(messages: readonly UserMessage[]): string[] {
  const names: string[] = [];
  const push = (name: string | undefined): void => {
    if (name === undefined || name === "" || names.includes(name)) return;
    names.push(name);
  };
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      for (const span of findReferences(block.text)) {
        if (span.reference.protocol !== SKILL_PROTOCOL) continue;
        push(span.reference.path);
      }
      for (const name of inlineCodeSkillNames(block.text)) push(name);
    }
  }
  return names;
}
