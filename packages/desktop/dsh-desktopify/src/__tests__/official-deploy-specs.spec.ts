import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { officialDeploySpecs } from "../cli/official-deps.ts";
import { OFFICIAL_PROFILE_PACKAGES } from "../official-packages.generated.ts";

const roots: string[] = [];

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-deploy-specs-"));
  roots.push(root);
  return root;
}

async function manifest(dir: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(value)}\n`);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("official deploy specs", () => {
  it("installs registry packages, pins what the workspace lacks, and leaves sources to the walk", async () => {
    const dshPackages = OFFICIAL_PROFILE_PACKAGES.filter((name) =>
      name.startsWith("@deepseek-ai/dsh-"),
    );
    const nonHarness = OFFICIAL_PROFILE_PACKAGES.find(
      (name) => !name.startsWith("@deepseek-ai/dsh-"),
    );
    if (dshPackages.length < 3 || nonHarness === undefined) {
      throw new Error("generated official packages list is too small for this fixture");
    }
    const registry = dshPackages[0] as string;
    const sourceTree = dshPackages[1] as string;
    const absent = dshPackages[2] as string;

    const root = await workDir();
    const workspace = join(root, "app");
    const official = join(workspace, "node_modules", "@deepseek-ai");
    await manifest(join(official, "dsh"), { name: "@deepseek-ai/dsh", version: "1.2.3" });
    await manifest(join(official, registry.split("/")[1] as string), {
      name: registry,
      version: "0.9.0",
    });

    const source = join(root, "vendor", sourceTree.split("/")[1] as string);
    await manifest(source, { name: sourceTree, version: "9.9.9" });
    await symlink(source, join(official, sourceTree.split("/")[1] as string), "dir");

    const specs = await officialDeploySpecs(
      { workspace, workspaceRoot: root, toolRoot: join(root, "tool", "pkg"), dshVersion: "1.2.3" },
      "1.2.3",
    );

    expect(specs["@deepseek-ai/dsh"]).toBe("1.2.3");
    expect(specs[registry]).toBe("^0.9.0");

    expect(specs[absent]).toBe("1.2.3");

    expect(specs[nonHarness]).toBeUndefined();

    expect(specs[sourceTree]).toBeUndefined();
    // host 是工具自己的变体包，由闭包以 `link:` 装配，不进部署的 registry specs。
    expect(specs["@morlay/dsh-desktop-host"]).toBeUndefined();
  });

  it("leaves a workspace-sourced app entirely to the closure walk", async () => {
    const root = await workDir();

    const specs = await officialDeploySpecs(
      {
        workspace: join(root, "app"),
        workspaceRoot: root,
        toolRoot: join(root, "tool", "pkg"),
        dshVersion: "workspace:*",
      },
      "1.2.3",
    );

    expect(specs).toEqual({});
  });
});
