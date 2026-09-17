import type { MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "./contract/slots.ts";

export function markdownLabels(t: ChatViewSlotProps["t"]): MarkdownLabels {
  return {
    code: { copyLabel: t("copy"), copiedLabel: t("copied") },
    footnotes: t("markdown.footnotes"),
  };
}
