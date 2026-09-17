import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import {
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
} from "@deepseek-ai/dsh-skill";
import { skillNamesIn } from "./links.ts";

export const name = "reference-injection";

export const inject = ["skills"];

export function apply(ctx: Context): void {
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const names = skillNamesIn(messages);
    if (names.length === 0) return decision;
    signal.throwIfAborted();
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent };
    const injections: UserMessage[] = [];
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup);
      signal.throwIfAborted();

      if (skill === undefined || !isUserInvocable(skill)) continue;
      const source: SkillInvocationSource = {
        kind: "skill-invocation",
        name,
        form: "instructions",
      };
      injections.push(
        createUserMessage({
          content: [{ type: "text", text: renderSkillContent(skill) }],
          source,
        }),
      );
    }
    if (injections.length === 0) return decision;
    return { ...decision, messages: [...decision.messages, ...injections] };
  });
}
