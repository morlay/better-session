import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  type AssembledSection,
} from "@deepseek-ai/dsh-system-prompt";
import { latestReminderText, reminderMessage, renderReminder } from "./reminder.ts";

export const name = "prompt-reminder";

export const inject = ["systemPrompt"];

export interface Config {
  keep?: string[];
}

export const Config: z<Config> = z.object({
  keep: z.array(z.string()).default([PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION]),
});

function demote(
  sections: readonly AssembledSection[],
  keep: ReadonlySet<string>,
): { sections: AssembledSection[]; texts: string[] } {
  const kept: AssembledSection[] = [];
  const texts: string[] = [];
  for (const section of sections) {
    if (keep.has(section.name) || section.text.length === 0) kept.push(section);
    else texts.push(section.text);
  }
  return { sections: kept, texts };
}

export function apply(ctx: Context, config: Config): void {
  const keep = new Set(config.keep ?? []);

  const captured = new WeakMap<Agent, string>();

  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const result = await next();
    const { sections, texts } = demote(result.sections, keep);
    const agent = context.agent;
    if (agent !== undefined) {
      if (texts.length === 0) captured.delete(agent);
      else captured.set(agent, renderReminder(texts));
    }
    return texts.length === 0 ? result : { ...result, sections };
  });

  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    const decision = await next();

    if (decision.kind === "reject" || decision.messages.length === 0) return decision;
    const reminder = captured.get(agent);
    if (reminder === undefined) return decision;

    if (latestReminderText(agent) === reminder) return decision;

    const claimedEnd = decision.messages.findLastIndex((message) => messages.includes(message));
    return {
      ...decision,
      messages: decision.messages.toSpliced(claimedEnd + 1, 0, reminderMessage(reminder)),
    };
  });

  ctx.on(
    "agent/request-error",
    async ({ agent, signal }, next) => {
      const action = await next();
      if (action?.kind !== "retry" || signal.aborted) return action;
      const reminder = captured.get(agent);
      if (reminder === undefined || latestReminderText(agent) === reminder) return action;
      agent.session.append("user/message", reminderMessage(reminder), { surfaceOp: "append" });
      return action;
    },
    { prepend: true },
  );
}
