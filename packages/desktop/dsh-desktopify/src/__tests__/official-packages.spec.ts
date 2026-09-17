import { describe, expect, it } from "vitest";
import { collectOfficialProfilePackages } from "../official-packages.ts";
import { OFFICIAL_PROFILE_PACKAGES } from "../official-packages.generated.ts";

describe("official profile packages", () => {
  it("matches the upstream bundle patches", async () => {
    const expected = await collectOfficialProfilePackages();
    expect([...OFFICIAL_PROFILE_PACKAGES]).toEqual(expected);
  });

  it("carries no duplicate or blank entries", () => {
    expect(new Set(OFFICIAL_PROFILE_PACKAGES).size).toBe(OFFICIAL_PROFILE_PACKAGES.length);
    for (const name of OFFICIAL_PROFILE_PACKAGES) {
      expect(name.startsWith("@deepseek-ai/")).toBe(true);
      expect(name.split("/")).toHaveLength(2);
    }
  });
});
