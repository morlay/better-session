import { describe, expect, it } from "vitest";
import {
  OFFICIAL_PROFILE_BUNDLES,
  OFFICIAL_RUNTIME_PACKAGES,
  DESKTOP_HOST_PACKAGE,
} from "../official.ts";
import { OFFICIAL_PROFILE_PACKAGES } from "../official-packages.generated.ts";

describe("official runtime packages", () => {
  it("starts with the harness install anchor and our own desktop host", () => {
    expect(OFFICIAL_RUNTIME_PACKAGES.slice(0, 2)).toEqual([
      "@deepseek-ai/dsh",
      DESKTOP_HOST_PACKAGE,
    ]);
  });

  it("carries every profile package the upstream bundles pull in", () => {
    for (const name of OFFICIAL_PROFILE_PACKAGES) {
      expect(OFFICIAL_RUNTIME_PACKAGES).toContain(name);
    }
    expect(OFFICIAL_RUNTIME_PACKAGES).toHaveLength(OFFICIAL_PROFILE_PACKAGES.length + 2);
    expect(new Set(OFFICIAL_RUNTIME_PACKAGES).size).toBe(OFFICIAL_RUNTIME_PACKAGES.length);
  });

  it("declares deepseek packages plus the tool's own host variant", () => {
    for (const name of OFFICIAL_RUNTIME_PACKAGES) {
      if (name === DESKTOP_HOST_PACKAGE) continue;
      expect(name.startsWith("@deepseek-ai/")).toBe(true);
      expect(name.split("/")).toHaveLength(2);
    }
    expect(DESKTOP_HOST_PACKAGE).toBe("@morlay/dsh-desktop-host");
  });

  it("boots the base and web app bundles", () => {
    expect(OFFICIAL_PROFILE_BUNDLES).toEqual(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
    for (const name of OFFICIAL_PROFILE_BUNDLES) {
      expect(name.startsWith("@deepseek-ai/")).toBe(true);
    }
  });
});
