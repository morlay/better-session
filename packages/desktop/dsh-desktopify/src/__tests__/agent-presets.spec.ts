import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeAgentPresets } from "../cli/agent-presets.ts";
import { desktopAgentPresets } from "../cli/workspace.ts";

const roots: string[] = [];

function projectDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-desktopify-presets-"));
  roots.push(root);
  mkdirSync(join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
  return root;
}

function presetSource(project: string, spec: string, id: string): void {
  const dir = join(project, "node_modules", ...spec.split("/"), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.cordis.yml"), "- id: persona\n");
  writeFileSync(join(dir, "preset.yml"), `name: ${id}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop agent presets", () => {
  it("materializes declared preset directories into the dsh mount", () => {
    const project = projectDir();
    presetSource(project, "@morlay/dsh-preset/dist/presets", "standard");
    presetSource(project, "@morlay/dsh-preset/dist/presets", "ptc");

    materializeAgentPresets(project, ["@morlay/dsh-preset/dist/presets"]);

    const mount = join(project, "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets");
    expect(readFileSync(join(mount, "standard", "agent.cordis.yml"), "utf8")).toContain("persona");
    expect(readFileSync(join(mount, "ptc", "preset.yml"), "utf8")).toBe("name: ptc\n");
  });

  it("replaces the mount so a dropped preset leaves no residue", () => {
    const project = projectDir();
    presetSource(project, "@morlay/dsh-preset/dist/presets", "standard");
    presetSource(project, "@other/presets", "ptc");
    materializeAgentPresets(project, ["@morlay/dsh-preset/dist/presets"]);

    materializeAgentPresets(project, ["@other/presets"]);

    const mount = join(project, "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets");
    expect(existsSync(join(mount, "ptc"))).toBe(true);
    expect(existsSync(join(mount, "standard"))).toBe(false);
  });

  it("fails loud when a declared preset directory is missing", () => {
    const project = projectDir();

    expect(() => materializeAgentPresets(project, ["@morlay/dsh-preset/dist/presets"])).toThrow(
      /"@morlay\/dsh-preset\/dist\/presets" is missing/u,
    );
  });

  it("reads the declaration from the workspace manifest", () => {
    expect(desktopAgentPresets({ name: "app", dsh: { desktop: {} } })).toEqual([]);
    expect(
      desktopAgentPresets({
        name: "app",
        dsh: { desktop: { agentPresets: ["@scope/pkg/presets"] } },
      }),
    ).toEqual(["@scope/pkg/presets"]);
    expect(() =>
      desktopAgentPresets({ name: "app", dsh: { desktop: { agentPresets: [""] } } }),
    ).toThrow(/invalid dsh\.desktop\.agentPresets/u);
  });
});
