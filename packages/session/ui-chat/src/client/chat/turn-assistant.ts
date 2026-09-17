import type { AssistantBlock } from "../contract/snapshot.ts";

export function assistantText(blocks: readonly AssistantBlock[]): string {
  return blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("");
}
