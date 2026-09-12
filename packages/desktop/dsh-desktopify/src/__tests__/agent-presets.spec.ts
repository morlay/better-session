import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentPresetMount,
  discoverPresetMounts,
  materializeAgentPresets,
} from "../cli/agent-presets.ts";
import { desktopAgentPresets, type WorkspaceManifest } from "../cli/workspace.ts";

const roots: string[] = [];

function projectDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-desktopify-presets-"));
  roots.push(root);
  mkdirSync(join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
  return root;
}

function write(path: string, content = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** One profile bundle in the project's closure: manifest plus its preset files. */
function bundle(project: string, name: string, trees: unknown, presets: string[]): void {
  const dir = join(project, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  const manifest = trees === undefined ? { name } : { name, dsh: { configTrees: trees } };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest)}\n`);
  for (const preset of presets) {
    write(join(dir, "dist", "presets", preset, "preset.yml"), `name: ${preset}\n`);
  }
}

function appManifest(bundles: string[]): WorkspaceManifest {
  return { name: "app", dsh: { profile: { bundles } } } as WorkspaceManifest;
}

function mountPresets(project: string): string[] {
  return readdirSync(agentPresetMount(project)).sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop agent presets", () => {
  it("discovers the preset trees profile bundles declare", () => {
    const project = projectDir();
    bundle(
      project,
      "@morlay/dsh-preset",
      [{ mount: "config/agent-presets", path: "dist/presets", scanRoster: true }],
      ["standard", "ptc"],
    );
    // 官方 bundle 没有声明，另一个 bundle 的声明指向包外（不存在）→ 跳过不报错。
    bundle(project, "@deepseek-ai/dsh-base", undefined, []);
    bundle(project, "@other/loose", [{ mount: "config/agent-presets", path: "../../presets" }], []);

    const manifest = appManifest(["@morlay/dsh-preset", "@other/loose"]);
    materializeAgentPresets(
      project,
      discoverPresetMounts(manifest, join(project, "node_modules"), []),
    );

    expect(mountPresets(project)).toEqual(["ptc", "standard"]);
  });

  it("applies the app's explicit specs after the declared trees, so they override", () => {
    const project = projectDir();
    bundle(
      project,
      "@morlay/dsh-preset",
      [{ mount: "config/agent-presets", path: "dist/presets", scanRoster: true }],
      ["standard", "ptc"],
    );
    const override = join(project, "node_modules", "@other", "presets", "override");
    write(join(override, "standard", "preset.yml"), "name: standard-override\n");

    const manifest = appManifest(["@morlay/dsh-preset"]);
    const sources = discoverPresetMounts(manifest, join(project, "node_modules"), [
      "@other/presets/override",
    ]);
    materializeAgentPresets(project, sources);

    expect(mountPresets(project)).toEqual(["ptc", "standard"]);
    expect(
      readFileSync(join(agentPresetMount(project), "standard", "preset.yml"), "utf8"),
    ).toContain("standard-override");
  });

  it("refuses a malformed bundle declaration", () => {
    const project = projectDir();
    bundle(project, "@other/broken", [{ mount: "config/agent-presets" }], []);

    expect(() =>
      discoverPresetMounts(appManifest(["@other/broken"]), join(project, "node_modules"), []),
    ).toThrow(/dsh\.configTrees\[0\] must declare a string mount and a string path/u);
  });

  it("fails loud when an explicit preset spec is missing", () => {
    const project = projectDir();

    expect(() =>
      discoverPresetMounts(appManifest(["@morlay/dsh-preset"]), join(project, "node_modules"), [
        "@morlay/dsh-preset/dist/presets",
      ]),
    ).toThrow(/"@morlay\/dsh-preset\/dist\/presets" is missing/u);
    expect(existsSync(agentPresetMount(project))).toBe(false);
  });

  it("reads the explicit declaration from the workspace manifest", () => {
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
