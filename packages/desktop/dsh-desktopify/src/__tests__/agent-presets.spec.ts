import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function projectDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-presets-"));
  roots.push(root);
  await mkdir(join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
  return root;
}

async function write(path: string, content = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function bundle(
  project: string,
  name: string,
  trees: unknown,
  presets: string[],
): Promise<void> {
  const dir = join(project, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  const manifest = trees === undefined ? { name } : { name, dsh: { configTrees: trees } };
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest)}\n`);
  for (const preset of presets) {
    await write(join(dir, "dist", "presets", preset, "preset.yml"), `name: ${preset}\n`);
  }
}

function appManifest(bundles: string[]): WorkspaceManifest {
  return { name: "app", dsh: { profile: { bundles } } } as WorkspaceManifest;
}

async function mountPresets(project: string): Promise<string[]> {
  return (await readdir(agentPresetMount(project))).sort();
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("desktop agent presets", () => {
  it("discovers the preset trees profile bundles declare", async () => {
    const project = await projectDir();
    await bundle(
      project,
      "@morlay/dsh-preset",
      [{ mount: "config/agent-presets", path: "dist/presets", scanRoster: true }],
      ["standard", "ptc"],
    );

    await bundle(project, "@deepseek-ai/dsh-base", undefined, []);
    await bundle(
      project,
      "@other/loose",
      [{ mount: "config/agent-presets", path: "../../presets" }],
      [],
    );

    const manifest = appManifest(["@morlay/dsh-preset", "@other/loose"]);
    await materializeAgentPresets(
      project,
      await discoverPresetMounts(manifest, join(project, "node_modules"), []),
    );

    expect(await mountPresets(project)).toEqual(["ptc", "standard"]);
  });

  it("applies the app's explicit specs after the declared trees, so they override", async () => {
    const project = await projectDir();
    await bundle(
      project,
      "@morlay/dsh-preset",
      [{ mount: "config/agent-presets", path: "dist/presets", scanRoster: true }],
      ["standard", "ptc"],
    );
    const override = join(project, "node_modules", "@other", "presets", "override");
    await write(join(override, "standard", "preset.yml"), "name: standard-override\n");

    const manifest = appManifest(["@morlay/dsh-preset"]);
    const sources = await discoverPresetMounts(manifest, join(project, "node_modules"), [
      "@other/presets/override",
    ]);
    await materializeAgentPresets(project, sources);

    expect(await mountPresets(project)).toEqual(["ptc", "standard"]);
    expect(
      await readFile(join(agentPresetMount(project), "standard", "preset.yml"), "utf8"),
    ).toContain("standard-override");
  });

  it("refuses a malformed bundle declaration", async () => {
    const project = await projectDir();
    await bundle(project, "@other/broken", [{ mount: "config/agent-presets" }], []);

    await expect(async () =>
      discoverPresetMounts(appManifest(["@other/broken"]), join(project, "node_modules"), []),
    ).rejects.toThrow(/dsh\.configTrees\[0\] must declare a string mount and a string path/u);
  });

  it("fails loud when an explicit preset spec is missing", async () => {
    const project = await projectDir();

    await expect(async () =>
      discoverPresetMounts(appManifest(["@morlay/dsh-preset"]), join(project, "node_modules"), [
        "@morlay/dsh-preset/dist/presets",
      ]),
    ).rejects.toThrow(/"@morlay\/dsh-preset\/dist\/presets" is missing/u);
    expect(await exists(agentPresetMount(project))).toBe(false);
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
