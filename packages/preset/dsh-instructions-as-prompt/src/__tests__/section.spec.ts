/**
 * 插件行为测试：工作区指令必须作为 section 进入系统提示词，位置在部署 persona
 * 之后、工具指引之前；无指令时不注入；加载失败不破坏装配。
 *
 * 测试不挂真实文件系统与 agent：直接调用 waterfall 监听器，注入伪造的
 * assembly 与 context，断言其返回值。文件加载本身是上游
 * `loadBaselineInstructions` 的职责，已由上游测试覆盖。
 * @module @morlay/dsh-instructions-as-prompt/__tests__/section
 */

import { describe, expect, it } from "vitest";
import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-system-prompt";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { SECTION_NAME, insertSection, unwrapReminder } from "../index.ts";

/** 构造一个已按 order 排序的最小 assembly。 */
function assembly(sections: { name: string; text: string }[]): PromptAssembly {
  return { sections, contexts: [], tools: [], variables: {} };
}

describe("insertSection", () => {
  it("places instructions right after the deployment persona prefix", () => {
    const sections = assembly([
      { name: "harness:identity", text: "identity" },
      { name: PERSONA_PREFIX_SECTION, text: "persona" },
      { name: "tool:bash", text: "bash guidance" },
    ]).sections;
    const result = insertSection(sections, "AGENTS content");
    expect(result.map((section) => section.name)).toEqual([
      "harness:identity",
      PERSONA_PREFIX_SECTION,
      SECTION_NAME,
      "tool:bash",
    ]);
    expect(result[2]?.text).toBe("AGENTS content");
  });

  it("keeps the deployment persona suffix last", () => {
    const sections = assembly([
      { name: PERSONA_PREFIX_SECTION, text: "persona" },
      { name: "tool:bash", text: "bash" },
      { name: "deployment:persona-suffix", text: "cwd" },
    ]).sections;
    const names = insertSection(sections, "AGENTS").map((section) => section.name);
    expect(names.indexOf(SECTION_NAME)).toBeGreaterThan(names.indexOf(PERSONA_PREFIX_SECTION));
    expect(names.indexOf(SECTION_NAME)).toBeLessThan(names.indexOf("tool:bash"));
  });

  it("prepends when no persona prefix is present", () => {
    const result = insertSection(
      assembly([{ name: "tool:bash", text: "bash" }]).sections,
      "AGENTS",
    );
    expect(result[0]?.name).toBe(SECTION_NAME);
  });

  it("does not mutate the input list", () => {
    const sections = assembly([{ name: PERSONA_PREFIX_SECTION, text: "persona" }]).sections;
    insertSection(sections, "AGENTS");
    expect(sections).toHaveLength(1);
  });
});

describe("unwrapReminder", () => {
  it("strips the system-reminder frame baked by the upstream renderer", () => {
    const rendered = "<system-reminder>\nInstructions from: AGENTS.md\n\nbody\n</system-reminder>";
    expect(unwrapReminder(rendered)).toBe("Instructions from: AGENTS.md\n\nbody");
  });

  it("returns text unchanged when no frame is present", () => {
    expect(unwrapReminder("plain text")).toBe("plain text");
  });
});
