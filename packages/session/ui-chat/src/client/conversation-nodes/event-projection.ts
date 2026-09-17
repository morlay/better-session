import type { ContentBlock, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type {
  AssistantBlock,
  ContextProducerView,
  KnownContextForm,
} from "@morlay/dsh-client-ui-conversation/client";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member];
  if (!Array.isArray(list)) return [];
  const seen: string[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const value = record === null ? null : readString(record, field);
    if (value !== null && !seen.includes(value)) seen.push(value);
  }
  return seen;
}

function joined(names: string[]): string | null {
  return names.length > 0 ? names.join(", ") : null;
}

const KNOWN_FORMS: readonly KnownContextForm[] = [
  "instructions",
  "catalog",
  "snapshot",
  "notice",
  "relay",
  "recall",
];

export function contextForm(source: unknown): KnownContextForm | null {
  const record = asRecord(source);
  const form = record === null ? null : readString(record, "form");
  return form !== null && (KNOWN_FORMS as readonly string[]).includes(form)
    ? (form as KnownContextForm)
    : null;
}

export function contextProducer(source: unknown): ContextProducerView {
  const record = asRecord(source);
  const kind = record === null ? null : readString(record, "kind");
  if (record === null || kind === null) return { role: "inject", label: null };
  switch (kind) {
    case "session-reference":
      return { role: "recall", label: joined(collect(record, "references", "label")) ?? kind };
    case "agent-instructions":
      return { role: "inject", label: joined(collect(record, "changes", "path")) ?? kind };
    case "plugin":
      return { role: "inject", label: readString(record, "plugin") ?? kind };
    case "skill-invocation":
      return { role: "inject", label: readString(record, "name") ?? kind };
    default:
      return { role: "inject", label: kind };
  }
}

export function sessionRecallLabels(source: unknown): string[] {
  const record = asRecord(source);
  if (record === null || readString(record, "kind") !== "session-reference") return [];
  return collect(record, "references", "label");
}

export function skillInvocationName(source: unknown): string | null {
  const record = asRecord(source);
  if (record === null || readString(record, "kind") !== "skill-invocation") return null;
  return readString(record, "name");
}

export function toAssistantBlocks(content: readonly ContentBlock[]): AssistantBlock[] {
  return content.map(toAssistantBlock);
}

export function toAssistantBlock(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text };
    case "reasoning":
      return { kind: "reasoning", text: block.text };
    case "image":
      return { kind: "image", attachment: block.attachment };
    case "tool-call":
      return {
        kind: "tool-call",
        callId: String(block.id),
        name: block.name,
        argsRaw: block.arguments,
      };
    default:
      return { kind: "other", block };
  }
}

export function emptyAssistantBlock(blockType: string): AssistantBlock {
  switch (blockType) {
    case "text":
      return { kind: "text", text: "" };
    case "reasoning":
      return { kind: "reasoning", text: "" };
    case "tool-call":
      return { kind: "tool-call", callId: "", name: "", argsRaw: "" };
    default:
      return { kind: "other", block: null };
  }
}

export interface DisplayFailure {
  readonly code?: string;
  readonly message: string;
}

export function displayFailure(failure: unknown): DisplayFailure {
  if (failure === null || typeof failure !== "object") return { message: String(failure) };
  const record = failure as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;

  if (code === "AUTH") return { code, message: "" };
  return {
    ...(code === undefined ? {} : { code }),
    message: typeof record.message === "string" ? record.message : JSON.stringify(failure),
  };
}

export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta":
      return chunk.text !== "";
    case "tool-call-delta":
      return chunk.argumentsDelta !== "" || chunk.name !== undefined;
    default:
      return false;
  }
}
