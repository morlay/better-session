/**
 * 真实 pre-step 路径：baseline 不进对话（inbox 空、无 user 消息），system prompt
 * 才是它的落点。用生产 AgentLoop + 真实 Agent/Session 驱动，不 mock 上游。
 * @module @morlay/dsh-agent-instructions-as-prompt/__tests__/pre-step
 */

import { Context } from "@deepseek-ai/cordis";
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { turnBoundaryProjectionDefinition } from "@deepseek-ai/dsh-agent-loop";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import { SessionId } from "@deepseek-ai/dsh-session";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as plugin from "../index.ts";
import { SECTION_NAME_PREFIX } from "../prompt.ts";

const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "pre-step-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  return root;
}

/** 挂载生产 AgentLoop + 本插件，创建一个 cwd 指向项目的 agent。 */
async function mount(root: string) {
  const ctx = new Context();
  contexts.push(ctx);
  await mountAgentLoopTestDependencies(ctx);
  const harness = await mountAgentLoopTestHarness(ctx);
  await ctx.plugin(LocalFileSystem, { cwd: "/" });
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
  await ctx.plugin(plugin, {
    maxBytes: 65536,
    dshHome: join(root, "no-home"),
    projectRootMarkers: [".git"],
  });
  const agent = await harness.create(
    SessionId(`pre-step-${Date.now()}-${Math.random()}`),
    {},
    { cwd: root },
  );
  return { ctx, agent };
}

/** 跑一次 pre-step waterfall（上游 loop 每步开始时做的事）。 */
async function runPreStep(ctx: Context, agent: Awaited<ReturnType<typeof mount>>["agent"]) {
  return agentEvents(ctx, agent).waterfall(
    "agent/pre-step",
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter" as const, messages: [] }),
  );
}

describe("pre-step", () => {
  it("leaves the conversation empty: the baseline is a system-prompt section", async () => {
    const root = project();
    writeFileSync(join(root, "AGENTS.md"), "# 规则\n\nYAGNI。");
    const { ctx, agent } = await mount(root);

    const decision = await runPreStep(ctx, agent);

    expect(decision.kind === "enter" ? decision.messages : []).toEqual([]);
    expect(agent.inbox.nextStep).toEqual([]);
    expect(agent.session.snapshotEvents().filter((event) => event.type === "user/message")).toEqual(
      [],
    );
  });

  it("assembles the instruction section for the same session", async () => {
    const root = project();
    writeFileSync(join(root, "AGENTS.md"), "# 规则\n\nYAGNI。");
    const { ctx, agent } = await mount(root);
    await runPreStep(ctx, agent);

    const assembly = await ctx.systemPrompt.assemble({ agent });
    const sections = assembly.sections.filter((section) =>
      section.name.startsWith(SECTION_NAME_PREFIX),
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain("YAGNI");
  });
});
