/**
 * 渲染与识别降级 reminder：信封沿用工作区指令的 `<system-reminder>` 约定。
 * @module @morlay/dsh-prompt-reminder/reminder
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-session";

const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";

// 首行声明来源与替代语义：模型需要知道这些是系统级规则、且最新一条覆盖旧的。
const REMINDER_INTRO =
  "The system prompt for this session is deliberately minimal. The guidance below belongs to it and stays in force; the newest reminder supersedes every earlier one.";

/** 本插件注入的 user 消息来源（`MessageSourceMap` 是 merge-extensible 的）。 */
export interface PromptReminderSource {
  kind: "prompt-reminder";
  form: "instructions";
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "prompt-reminder": PromptReminderSource;
  }
}

// 正文里出现闭合标记会提前结束信封，替换成转义写法。
function escapeFrameBody(body: string): string {
  return body.replaceAll(REMINDER_CLOSE, "<\\/system-reminder>");
}

/** 按原 order 拼接降级 section 文本，渲染一条 reminder 消息文本。 */
export function renderReminder(sectionTexts: readonly string[]): string {
  const body = sectionTexts.map(escapeFrameBody).join("\n\n");
  return `${REMINDER_OPEN}\n${REMINDER_INTRO}\n\n${body}\n${REMINDER_CLOSE}`;
}

/** 该 user 消息是否由本插件注入。 */
export function isPromptReminder(message: UserMessage): boolean {
  return message.source.kind === "prompt-reminder";
}

/** 会话 surface 上最近一条 reminder 的文本；跨进程重启后据此恢复幂等。 */
export function latestReminderText(agent: Agent): string | undefined {
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.eventAt(seq);
    if (event?.type !== "user/message" || !isPromptReminder(event.data)) continue;
    const [block] = event.data.content;
    return event.data.content.length === 1 && block?.type === "text" ? block.text : "";
  }
  return undefined;
}

/** 构造一条 reminder user 消息。 */
export function reminderMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "prompt-reminder", form: "instructions" },
  });
}
