import { describe, expect, it } from "vitest";
import { mergedDeploySettings } from "../cli/workspace.ts";

const DEPLOYED = ["allowBuilds:", '  "koffi": true', '  "protobufjs": true', ""].join("\n");

function lines(...values: string[]): string {
  return `${values.join("\n")}\n`;
}

describe("mergedDeploySettings", () => {
  it("inherits the resolution and supply-chain scalars", () => {
    const source = lines(
      "packages:",
      "  - apps/*",
      "",
      "linkWorkspacePackages: true",
      "minimumReleaseAge: 0",
      "nodeLinker: hoisted",
      "autoInstallPeers: true",
    );

    const merged = mergedDeploySettings(source, DEPLOYED);

    expect(merged).toBe(
      lines(
        "allowBuilds:",
        '  "koffi": true',
        '  "protobufjs": true',
        "minimumReleaseAge: 0",
        "nodeLinker: hoisted",
        "autoInstallPeers: true",
      ),
    );
  });

  it("inherits a list block as a whole", () => {
    const source = lines(
      "minimumReleaseAge: 0",
      "minimumReleaseAgeExclude:",
      "  - cordis",
      '  - "@cordisjs/plugin-loader"',
      "autoInstallPeers: true",
    );

    const merged = mergedDeploySettings(source, DEPLOYED);

    expect(merged).toBe(
      lines(
        "allowBuilds:",
        '  "koffi": true',
        '  "protobufjs": true',
        "minimumReleaseAge: 0",
        "minimumReleaseAgeExclude:",
        "  - cordis",
        '  - "@cordisjs/plugin-loader"',
        "autoInstallPeers: true",
      ),
    );
  });

  it("replaces a key the deployed manifest already declares", () => {
    const deployed = lines("minimumReleaseAge: 1440", "nodeLinker: isolated", "allowBuilds:");
    const source = lines("minimumReleaseAge: 0", "nodeLinker: hoisted");

    const merged = mergedDeploySettings(source, deployed);

    expect(merged).toBe(lines("minimumReleaseAge: 0", "nodeLinker: hoisted", "allowBuilds:"));
    expect(merged.match(/^minimumReleaseAge:/gmu)).toHaveLength(1);
    expect(merged).not.toContain("1440");
  });

  it("drops the replaced block's old indented lines", () => {
    const deployed = lines("minimumReleaseAgeExclude:", "  - stale-package", "allowBuilds:");
    const source = lines("minimumReleaseAgeExclude:", "  - fresh-package");

    const merged = mergedDeploySettings(source, deployed);

    expect(merged).toBe(lines("minimumReleaseAgeExclude:", "  - fresh-package", "allowBuilds:"));
    expect(merged).not.toContain("stale-package");
    expect(merged.match(/^minimumReleaseAgeExclude:/gmu)).toHaveLength(1);
  });

  it("keeps everything it does not own and never invents settings", () => {
    const deployed = lines(
      "allowBuilds:",
      '  "koffi": true',
      "patchedDependencies:",
      '  "@img/colour@1.1.0": patches/@img__colour@1.1.0.patch',
    );
    const source = lines(
      "packages:",
      "  - apps/*",
      "linkWorkspacePackages: true",
      "minimumReleaseAge: 0",
    );

    const merged = mergedDeploySettings(source, deployed);

    expect(merged).toBe(
      lines(
        "allowBuilds:",
        '  "koffi": true',
        "patchedDependencies:",
        '  "@img/colour@1.1.0": patches/@img__colour@1.1.0.patch',
        "minimumReleaseAge: 0",
      ),
    );
    expect(merged).not.toContain("packages:");
    expect(merged).not.toContain("linkWorkspacePackages");
  });

  it("returns the deployed manifest unchanged when the workspace declares nothing", () => {
    const source = lines("packages:", "  - apps/*", "");

    expect(mergedDeploySettings(source, DEPLOYED)).toBe(DEPLOYED);
    expect(mergedDeploySettings("", "")).toBe("");
  });
});
