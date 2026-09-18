import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_PROFILE_BUNDLES } from "../official.ts";
import {
  appProfileBundles,
  buildRoot,
  desktopConfig,
  dshVersion,
  findWorkspaceRoot,
  mergedProfileBundles,
  workspaceManifest,
  type WorkspaceManifest,
} from "../cli/workspace.ts";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-desktopify-workspace-"));
  roots.push(root);
  return root;
}

async function manifestDir(value: unknown): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "package.json"), `${JSON.stringify(value)}\n`);
  return dir;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("desktopConfig", () => {
  it("falls back to the documented defaults for a bare manifest", () => {
    const config = desktopConfig({ name: "dsh-custom" });

    expect(config).toEqual({
      id: "ai.deepseek.dsh.custom",
      version: "0.0.1",
      dshHome: "xdg",
      window: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
    });
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("takes the app id, home mode, icon, and a partial window from the manifest", () => {
    const config = desktopConfig({
      name: "dsh-custom",
      version: "0.1.5",
      dsh: {
        desktop: {
          id: "ai.deepseek.dsh.custom-next",
          dshHome: "env",
          icon: "icon.svg",
          window: { width: 1024, minHeight: 480 },
        },
      },
    });

    expect(config).toEqual({
      id: "ai.deepseek.dsh.custom-next",
      version: "0.1.5",
      dshHome: "env",
      icon: "icon.svg",
      window: { width: 1024, height: 800, minWidth: 800, minHeight: 480 },
    });
  });
});

describe("profile bundles", () => {
  it("puts the official bundles ahead of the app's own", () => {
    expect(
      mergedProfileBundles({
        name: "app",
        dsh: { profile: { bundles: ["@morlay/better-session", "@morlay/dsh-preset"] } },
      }),
    ).toEqual([...OFFICIAL_PROFILE_BUNDLES, "@morlay/better-session", "@morlay/dsh-preset"]);
  });

  it("refuses a manifest without a usable bundle list", () => {
    expect(() => appProfileBundles({ name: "app" })).toThrow(/has no dsh\.profile\.bundles/u);
    expect(() => appProfileBundles({ name: "app", dsh: { profile: { bundles: "x" } } })).toThrow(
      /has no dsh\.profile\.bundles/u,
    );
    expect(() => appProfileBundles({ name: "app", dsh: { profile: { bundles: [7] } } })).toThrow(
      /has no dsh\.profile\.bundles/u,
    );
  });

  it("reads dsh.version verbatim and rejects a broken one", () => {
    expect(dshVersion({ name: "app" })).toBeUndefined();
    expect(dshVersion({ name: "app", dsh: { version: "workspace:*" } })).toBe("workspace:*");
    expect(dshVersion({ name: "app", dsh: { version: "0.1.6-alpha.1" } })).toBe("0.1.6-alpha.1");
    expect(() => dshVersion({ name: "app", dsh: { version: "" } })).toThrow(
      /has an invalid dsh\.version/u,
    );
    const numeric = { name: "app", dsh: { version: 7 } } as unknown as WorkspaceManifest;
    expect(() => dshVersion(numeric)).toThrow(/has an invalid dsh\.version/u);
  });
});

describe("workspace layout", () => {
  it("keeps generated artefacts under the workspace node_modules", async () => {
    const workspace = await tempDir();

    expect(buildRoot(workspace)).toBe(join(workspace, "node_modules", ".dsh-desktopify"));
    expect(buildRoot(workspace).startsWith(workspace + sep)).toBe(true);
  });

  it("finds the nearest pnpm workspace root above the app", async () => {
    const root = await tempDir();
    const app = join(root, "apps", "custom");
    await mkdir(app, { recursive: true });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");

    expect(await findWorkspaceRoot(app)).toBe(root);
    expect(await findWorkspaceRoot(root)).toBe(root);
  });

  it("refuses to guess a workspace root", async () => {
    const standalone = join(await tempDir(), "standalone");
    await mkdir(standalone, { recursive: true });

    await expect(async () => findWorkspaceRoot(standalone)).rejects.toThrow(
      /no pnpm-workspace\.yaml found above/u,
    );
  });

  it("reads the manifest name and refuses a manifest without one", async () => {
    expect(
      await workspaceManifest(await manifestDir({ name: "dsh-custom", version: "0.1.5" })),
    ).toEqual({
      name: "dsh-custom",
      version: "0.1.5",
    });
    await expect(async () =>
      workspaceManifest(await manifestDir({ version: "0.1.5" })),
    ).rejects.toThrow(/has no package name/u);
    await expect(async () => workspaceManifest(await manifestDir({ name: "" }))).rejects.toThrow(
      /has no package name/u,
    );
  });
});
