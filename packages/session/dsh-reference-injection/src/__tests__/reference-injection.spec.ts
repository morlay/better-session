import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type { SkillDefinition } from "@deepseek-ai/dsh-skill";
import { apply } from "../index.ts";
import { skillNamesIn } from "../links.ts";

type Listener = (
  payload: {
    agent: { session: { header: { cwd: string } } };
    messages: UserMessage[];
    signal: AbortSignal;
  },
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>;

function userMessage(text: string, kind = "user"): UserMessage {
  return { content: [{ type: "text", text }], source: { kind } } as unknown as UserMessage;
}

function skill(name: string, userInvocable = true): SkillDefinition {
  return {
    name,
    provider: "local",
    content: `# ${name} 正文`,
    invocation: { userInvocable, modelInvocable: true },
  } as unknown as SkillDefinition;
}

function mount(skills: Record<string, SkillDefinition | undefined>): Listener {
  const listeners: Listener[] = [];
  const ctx = {
    on: (_name: string, listener: Listener) => {
      listeners.push(listener);
      return () => {};
    },
    skills: {
      get: (name: string): Promise<SkillDefinition | undefined> => Promise.resolve(skills[name]),
    },
  } as unknown as Context;
  apply(ctx);
  const listener = listeners[0];
  if (listener === undefined) throw new Error("apply registered no pre-step listener");
  return listener;
}

function step(listener: Listener, claimed: UserMessage[]): Promise<PreStepDecision> {
  return listener(
    {
      agent: { session: { header: { cwd: "/w" } } },
      messages: claimed,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: "enter", messages: claimed }),
  );
}

describe("skillNamesIn", () => {
  it("reads names in first-seen order without duplicates", () => {
    expect(skillNamesIn([userMessage("先 skill:alpha 再 skill:beta，又是 skill:alpha")])).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("ignores other sources, other schemes and code", () => {
    expect(skillNamesIn([userMessage("skill:alpha", "tool")])).toEqual([]);
    expect(skillNamesIn([userMessage("见 file:src/a.ts 与 `/alpha`")])).toEqual([]);
    expect(skillNamesIn([userMessage("```\nskill:alpha\n```")])).toEqual([]);
  });

  it("reads every reference form", () => {
    expect(skillNamesIn([userMessage("skill:beta")])).toEqual(["beta"]);
    expect(skillNamesIn([userMessage("@skill:gamma")])).toEqual(["gamma"]);
    expect(skillNamesIn([userMessage("[load](skill:delta)")])).toEqual(["delta"]);
    expect(skillNamesIn([userMessage("@[load](skill:epsilon)")])).toEqual(["epsilon"]);
    expect(skillNamesIn([userMessage("`skill:zeta`")])).toEqual(["zeta"]);
  });
});

describe("reference-injection", () => {
  it("injects the rendered skill body for a skill token", async () => {
    const listener = mount({ "code-review": skill("code-review") });
    const claimed = [userMessage("按 skill:code-review 过一遍")];
    const decision = await step(listener, claimed);
    expect(decision.kind).toBe("enter");
    if (decision.kind !== "enter") throw new Error("expected enter");
    expect(decision.messages).toHaveLength(2);
    const injected = decision.messages[1]!;
    expect(injected.content[0]).toMatchObject({
      type: "text",
    });
    expect((injected.content[0] as { text: string }).text).toContain(
      '<skill_content name="code-review">',
    );
    expect((injected.source as { kind?: unknown }).kind).toBe("skill-invocation");
  });

  it("keeps an unknown or user-disabled name as plain prose", async () => {
    const unknown = mount({});
    const missing = await step(unknown, [userMessage("skill:nope")]);
    expect(missing).toEqual({ kind: "enter", messages: [userMessage("skill:nope")] });

    const disabled = mount({ nope: skill("nope", false) });
    const kept = await step(disabled, [userMessage("skill:nope")]);
    expect(kept.kind).toBe("enter");
    if (kept.kind !== "enter") throw new Error("expected enter");
    expect(kept.messages).toHaveLength(1);
  });

  it("injects one message per distinct name", async () => {
    const listener = mount({
      alpha: skill("alpha"),
      beta: skill("beta"),
    });
    const decision = await step(listener, [userMessage("skill:alpha 与 skill:beta")]);
    expect(decision.kind).toBe("enter");
    if (decision.kind !== "enter") throw new Error("expected enter");
    expect(decision.messages.map((message) => (message.source as { name?: string }).name)).toEqual([
      undefined,
      "alpha",
      "beta",
    ]);
  });

  it("leaves a reference-free step and a reject untouched", async () => {
    const listener = mount({ alpha: skill("alpha") });
    expect(await step(listener, [userMessage("普通消息")])).toEqual({
      kind: "enter",
      messages: [userMessage("普通消息")],
    });
    const rejected = await listener(
      {
        agent: { session: { header: { cwd: "/w" } } },
        messages: [userMessage("skill:alpha")],
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "reject" }),
    );
    expect(rejected).toEqual({ kind: "reject" });
  });
});
