import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  profileLocalBundles,
  profileManifest,
  profileRuntimeLinks,
  profileWorkspace,
} from "../cli/prepare-seed.ts";
import type { WorkspaceManifest } from "../cli/workspace.ts";

const roots: string[] = [];

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-runtime-links-"));
  roots.push(root);
  return root;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function closureFixture(): Promise<{ root: string; modules: string }> {
  const root = await workDir();
  const modules = join(root, "node_modules");
  await write(
    join(modules, "@morlay", "plugin", "package.json"),
    JSON.stringify({
      name: "@morlay/plugin",
      dependencies: { zod: "^4.4.3", "@deepseek-ai/dsh-llm": "workspace:^" },
      peerDependencies: { "@deepseek-ai/dsh-session": "workspace:^" },
    }),
  );
  await write(
    join(modules, "zod", "package.json"),
    JSON.stringify({ name: "zod", version: "4.4.3" }),
  );
  await write(
    join(modules, ".pnpm", "store", "node_modules", "@deepseek-ai", "dsh-llm", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-llm", version: "0.1.6" }),
  );
  return { root, modules };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function app(bundles: readonly string[]): WorkspaceManifest {
  return {
    name: "dsh-custom",
    version: "0.1.6",
    dsh: { version: "workspace:^", profile: { bundles: [...bundles] } },
  } as WorkspaceManifest;
}

describe("profile seed manifest", () => {
  it("keeps the app's own bundles in the profile and leaves shipped ones to the runtime", () => {
    expect(profileLocalBundles(app(["@morlay/better-session", "dsh-context"]))).toEqual([
      "@morlay/better-session",
      "dsh-context",
    ]);
  });

  it("declares every local bundle as a file: dependency on its vendor copy", () => {
    expect(
      profileManifest(app(["@morlay/better-session", "dsh-context"]), [
        "@morlay/better-session",
        "dsh-context",
      ]),
    ).toEqual({
      name: "dsh-custom",
      private: true,
      version: "0.1.6",
      type: "module",
      dependencies: {
        "@morlay/better-session": "file:./vendor/@morlay/better-session",
        "dsh-context": "file:./vendor/dsh-context",
      },
      dsh: {
        profile: {
          bundles: [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "@morlay/better-session",
            "dsh-context",
          ],
        },
      },
    });
  });

  it("carries no workspace-only spec into the profile manifest", () => {
    const manifest = profileManifest(app(["@morlay/better-session"]), ["@morlay/better-session"]);
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
  });

  it("writes the pnpm settings the profile installs with", () => {
    expect(profileWorkspace("allowBuilds:\n  node-pty: true\n")).toBe(
      "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\n",
    );
  });
});

describe("profile runtime links", () => {
  it("links every dependency the closure carries, plain and workspace alike", async () => {
    const { root, modules } = await closureFixture();

    expect(await profileRuntimeLinks(root, modules, ["@morlay/plugin"])).toEqual([
      {
        name: "@deepseek-ai/dsh-llm",
        path: "node_modules/.pnpm/store/node_modules/@deepseek-ai/dsh-llm",
      },
      { name: "zod", path: "node_modules/zod" },
    ]);
  });

  it("drops a peer dependency the closure does not carry, because peers are not installed", async () => {
    const { root, modules } = await closureFixture();

    const links = await profileRuntimeLinks(root, modules, ["@morlay/plugin"]);
    expect(links.map((link) => link.name)).not.toContain("@deepseek-ai/dsh-session");
  });

  it("fails loud when a plain dependency is missing from the closure", async () => {
    const { root, modules } = await closureFixture();
    await rm(join(modules, "zod"), { recursive: true });

    await expect(profileRuntimeLinks(root, modules, ["@morlay/plugin"])).rejects.toThrow(/zod/u);
  });
});
