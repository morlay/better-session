import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-session";

const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";

const REMINDER_INTRO =
  "The system prompt for this session is deliberately minimal. The guidance below belongs to it and stays in force; the newest reminder supersedes every earlier one.";

export interface PromptReminderSource {
  kind: "prompt-reminder";
  form: "instructions";
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "prompt-reminder": PromptReminderSource;
  }
}

function escapeFrameBody(body: string): string {
  return body.replaceAll(REMINDER_CLOSE, "<\\/system-reminder>");
}

export function renderReminder(sectionTexts: readonly string[]): string {
  const body = sectionTexts.map(escapeFrameBody).join("\n\n");
  return `${REMINDER_OPEN}\n${REMINDER_INTRO}\n\n${body}\n${REMINDER_CLOSE}`;
}

export function isPromptReminder(message: UserMessage): boolean {
  return message.source.kind === "prompt-reminder";
}

export function latestReminderText(agent: Agent): string | undefined {
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.eventAt(seq);
    if (event?.type !== "user/message" || !isPromptReminder(event.data)) continue;
    const [block] = event.data.content;
    return event.data.content.length === 1 && block?.type === "text" ? block.text : "";
  }
  return undefined;
}

export function reminderMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "prompt-reminder", form: "instructions" },
  });
}
