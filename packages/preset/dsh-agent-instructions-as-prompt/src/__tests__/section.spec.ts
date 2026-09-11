/**
 * system-prompt section 标记的编解码：baseline 的元数据随渲染文本一起进
 * surface node 0，resume 后靠它重建冻结文本与可见指令状态。
 * @module @morlay/dsh-agent-instructions-as-prompt/__tests__/section-marker
 */

import { describe, expect, it } from "vitest";
import { escapeVariableReferences } from "../prompt.ts";
import {
  decodeBaselineSections,
  encodeBaselineSection,
  type BaselineSectionMeta,
} from "../section-marker.ts";

function meta(overrides: Partial<BaselineSectionMeta> = {}): BaselineSectionMeta {
  return {
    identity: "identity-1",
    scope: ".\u0000AGENTS.md",
    path: "./AGENTS.md",
    digest: "sha1-1",
    ...overrides,
  };
}

describe("baseline section markers", () => {
  it("round-trips one section", () => {
    const text = "Instructions from: ./AGENTS.md\n\n# 规则\n\nYAGNI。";
    const encoded = encodeBaselineSection(meta(), text);

    expect(decodeBaselineSections(encoded)).toEqual([{ ...meta(), text }]);
  });

  it("decodes every section in prompt order", () => {
    const prompt = [
      "deployment:persona-prefix text",
      encodeBaselineSection(meta({ path: "./AGENTS.md", digest: "a" }), "第一份"),
      encodeBaselineSection(meta({ path: "./sub/AGENTS.md", digest: "b" }), "第二份"),
    ].join("\n\n");

    expect(decodeBaselineSections(prompt).map((section) => [section.path, section.text])).toEqual([
      ["./AGENTS.md", "第一份"],
      ["./sub/AGENTS.md", "第二份"],
    ]);
  });

  it("keeps NUL-separated scope keys intact", () => {
    const scope = "sub\u0000AGENTS.md";
    const decoded = decodeBaselineSections(encodeBaselineSection(meta({ scope }), "正文"));

    expect(decoded[0]?.scope).toBe(scope);
  });

  it("ignores comments that are not its own marker", () => {
    const prompt = [
      "<!-- workspace-instructions -->",
      "<!-- workspace-instructions not json -->",
    ].join("\n");

    expect(decodeBaselineSections(prompt)).toEqual([]);
  });

  it("returns nothing for a prompt without markers", () => {
    expect(decodeBaselineSections("plain persona text")).toEqual([]);
  });
});

describe("variable references", () => {
  it("breaks {{ apart so the prompt interpolator cannot throw", () => {
    const escaped = escapeVariableReferences("use {{name}} here");

    expect(escaped).not.toContain("{{");
    expect(escaped.replaceAll("\u200b", "")).toBe("use {{name}} here");
  });

  it("leaves single braces alone", () => {
    expect(escapeVariableReferences("{ a: 1 }")).toBe("{ a: 1 }");
  });
});
