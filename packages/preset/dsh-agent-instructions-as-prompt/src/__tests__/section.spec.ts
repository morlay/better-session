/**
 * 纯函数行为：哪些 scope 进 system prompt，以及指令正文里的 `{{` 如何转义。
 * @module @morlay/dsh-agent-instructions-as-prompt/__tests__/prompt-scopes
 */

import { describe, expect, it } from "vitest";
import type { LoadedInstructionFile } from "../files.ts";
import { escapeVariableReferences, isPromptScope, promptInstructionFiles } from "../prompt.ts";
import { instructionScopeKey } from "../render.ts";

function file(displayPath: string): LoadedInstructionFile {
  return { absolutePath: `/abs/${displayPath}`, displayPath, content: `# ${displayPath}` };
}

describe("prompt scopes", () => {
  it("accepts the user-global and project-root scopes", () => {
    expect(isPromptScope(instructionScopeKey("AGENTS.md"))).toBe(true);
    expect(isPromptScope(instructionScopeKey("$DSH_HOME/AGENTS.md"))).toBe(true);
    expect(isPromptScope(instructionScopeKey("~/.dsh/AGENTS.md"))).toBe(true);
  });

  it("rejects nested directories", () => {
    expect(isPromptScope(instructionScopeKey("sub/AGENTS.md"))).toBe(false);
    expect(isPromptScope(instructionScopeKey("a/b/AGENTS.md"))).toBe(false);
  });

  it("keeps only prompt-scope files, in discovery order", () => {
    const files = [file("$DSH_HOME/AGENTS.md"), file("AGENTS.md"), file("sub/AGENTS.md")];

    expect(promptInstructionFiles(files).map((entry) => entry.displayPath)).toEqual([
      "$DSH_HOME/AGENTS.md",
      "AGENTS.md",
    ]);
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
