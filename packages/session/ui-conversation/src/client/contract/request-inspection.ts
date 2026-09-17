import type { ContentBlock, ToolSchema } from "@deepseek-ai/dsh-llm/types";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import type { AssistantProviderMetadataView, AssistantRequestConfig } from "./records.ts";

export type { AssistantProviderMetadataView, AssistantRequestConfig } from "./records.ts";

export interface ConversationPromptSnapshot {
  config: AssistantRequestConfig;

  system: string;

  tools: readonly ToolSchema[];
}

export interface SystemPromptNode {
  seq: number;

  time: number;

  turn: number;

  step: number;

  text: string;

  update: boolean;
}

export interface RequestPromptChange {
  seq: number;

  time: number;

  kind: "initial" | "system" | "tools" | "system-and-tools";

  previous?: ConversationPromptSnapshot;
}

export interface RequestPromptInspection {
  prompt: ConversationPromptSnapshot;

  change?: RequestPromptChange;
}

export type RequestPromptInspector = (
  previous: ConversationPromptSnapshot | undefined,
  event: SessionEvent<"request/header">,
  system: SystemPromptNode | undefined,
) => RequestPromptInspection;

export function inspectRequestPrompt(
  previous: ConversationPromptSnapshot | undefined,
  event: SessionEvent<"request/header">,
  system: SystemPromptNode | undefined,
): RequestPromptInspection {
  const header = event.data.header;
  const rawTools: unknown = header.tools;
  const prompt: ConversationPromptSnapshot = {
    config: header.config,
    system: system?.text ?? "",
    tools: Array.isArray(rawTools) ? (rawTools as readonly ToolSchema[]) : [],
  };
  if (previous === undefined && event.data.reason !== "initial") return { prompt };
  const systemChanged =
    previous !== undefined && previous.system !== prompt.system && system?.update !== true;
  const toolsChanged =
    previous !== undefined && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools);
  if (previous !== undefined && !systemChanged && !toolsChanged) return { prompt };
  const origin = system !== undefined && (previous === undefined || systemChanged) ? system : event;
  return {
    prompt,
    change: {
      seq: origin.seq,
      time: origin.time,
      kind:
        previous === undefined
          ? "initial"
          : systemChanged && toolsChanged
            ? "system-and-tools"
            : systemChanged
              ? "system"
              : "tools",
      ...(previous === undefined ? {} : { previous }),
    },
  };
}

interface RequestViewBase {
  startSeq: number;
  startedAt: number;
  completedAt: number | null;
  status: "running" | "complete" | "error";
  error?: string;

  errorCode?: string;
  providerMetadata?: AssistantProviderMetadataView;
  requestConfig?: AssistantRequestConfig;
  usage?: unknown;

  resultSeq?: number;
}

interface AssistantRequestView extends RequestViewBase {
  purpose: "assistant";
  turn: number;

  step: number;

  prompt?: ConversationPromptSnapshot;

  promptChange?: RequestPromptChange;

  retry?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

interface CompactionRequestView extends RequestViewBase {
  purpose: "compaction";

  turn: number | null;

  step: 0;

  replacementSeq?: number;

  summary?: readonly ContentBlock[];

  rawOutput?: readonly ContentBlock[];
}

export type RequestView = AssistantRequestView | CompactionRequestView;

export interface RequestInspectionSnapshot {
  requests: readonly RequestView[];
  callSchemas: ReadonlyMap<string, ToolSchema>;
}
