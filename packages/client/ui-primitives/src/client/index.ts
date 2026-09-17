import type { Context } from "@deepseek-ai/cordis";

export * from "./styling/index.ts";
export * from "./theme.ts";
export * from "./markdown-labels.ts";

export {
  findReferences,
  formatReference,
  isLocalReference,
  parseReference,
  parseReferenceToken,
} from "../reference.ts";
export type { Reference, ReferenceSpan } from "../reference.ts";
export { ReferenceMarkdown, referenceMentions } from "../reference-markdown.tsx";
export type { ReferenceActions, ReferenceMarkdownProps } from "../reference-markdown.tsx";

export const inject: readonly string[] = [];

export function apply(_ctx: Context): void {}
