import type { MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";

export type MarkdownCopySeat = (key: "copy" | "copied" | "markdown.footnotes") => string;

export function markdownLabels(t: MarkdownCopySeat): MarkdownLabels {
  return {
    code: { copyLabel: t("copy"), copiedLabel: t("copied") },
    footnotes: t("markdown.footnotes"),
  };
}
