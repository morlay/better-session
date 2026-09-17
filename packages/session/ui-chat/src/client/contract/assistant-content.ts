import type { AssistantBlock } from "@morlay/dsh-client-ui-conversation/client";

export function hasAssistantReplyContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === "reasoning" || block.kind === "tool-call") return false;
    if (block.kind === "text") return block.text.trim() !== "";
    return true;
  });
}
