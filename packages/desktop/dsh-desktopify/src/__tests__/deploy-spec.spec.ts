import { describe, expect, it } from "vitest";
import { cleanDeployedSpec } from "../cli/workspace.ts";

const NESTED_SUFFIX =
  "0.0.4(@deepseek-ai/cordis@4.0.2)(@deepseek-ai/dsh-agent@0.1.5-rc.2(6df6622855b87cb7fde1fe609a6d039a))" +
  "(@deepseek-ai/dsh-llm@0.1.5-rc.2(@deepseek-ai/cordis@4.0.2))" +
  "(@deepseek-ai/dsh-session@0.1.5-rc.2(@deepseek-ai/cordis@4.0.2)(@deepseek-ai/dsh-scope@0.1.5-rc.2(@deepseek-ai/cordis@4.0.2)))";

describe("cleanDeployedSpec", () => {
  it("passes through a spec pnpm wrote without a peer suffix", () => {
    expect(cleanDeployedSpec("0.0.19")).toBe("0.0.19");
    expect(cleanDeployedSpec("^1.0.2")).toBe("^1.0.2");
    expect(cleanDeployedSpec("workspace:*")).toBe("workspace:*");
  });

  it("cuts a flat peer suffix (hash-shaped peers)", () => {
    expect(cleanDeployedSpec("0.0.19(ae133e873c7e67cff9dee7e757b50e28)")).toBe("0.0.19");
  });

  it("cuts a nested peer suffix at the first bracket", () => {
    expect(cleanDeployedSpec(NESTED_SUFFIX)).toBe("0.0.4");
  });

  it("leaves nothing but the version for a spec whose peers carry peers", () => {
    const cleaned = cleanDeployedSpec(NESTED_SUFFIX);
    expect(cleaned).not.toContain("(");
    expect(cleaned).toBe("0.0.4");
  });
});
