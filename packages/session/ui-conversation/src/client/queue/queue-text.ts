import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";

/** 队列行的两种文本投影：未截断的纯文本，与给人看的预览。 */
export interface QueueRowText {
  /** 全文本块时的未截断文本；有非文本块时为 null（不可编辑）。 */
  readonly text: string | null;
  /** 非文本块按 [type] 占位、压过空白并截断的展示文本。 */
  readonly preview: string;
}

const QUEUE_PREVIEW_CHARS = 200;

/** 未截断的纯文本：只有整行都是文本块时才存在。 */
function textOf(content: readonly ContentBlock[]): string | null {
  if (!content.every((block) => block.type === "text")) return null;
  return content.map((block) => block.text).join("");
}

/** 展示预览：图片 / 文件块不占位，其余非文本块以 [type] 占位。 */
function previewOf(content: readonly ContentBlock[]): string {
  const flat = content
    .filter((block) => block.type !== "image" && block.type !== "file")
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > QUEUE_PREVIEW_CHARS
    ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join("")}…`
    : flat;
}

/** 从行的 content 块派生队列行文本（inbox 行只有 content，没有 text/preview 字段）。 */
export function queueRowTextOf(content: readonly ContentBlock[]): QueueRowText {
  return { text: textOf(content), preview: previewOf(content) };
}

/** 行内渲染用的文本：优先未截断文本，让整条裸引用落进 chip 而不是被预览截断。 */
export function queueTextOf(row: QueueRowText): string {
  return row.text ?? row.preview;
}
