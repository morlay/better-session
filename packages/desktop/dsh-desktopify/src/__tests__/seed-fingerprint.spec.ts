import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedFingerprint } from "../cli/prepare-seed.ts";

const roots: string[] = [];

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-fingerprint-"));
  roots.push(root);
  return root;
}

async function write(path: string, content = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

interface Fixture {
  readonly workspace: string;
  readonly workspaceRoot: string;
  readonly closureModulesDir: string;
  readonly seedRoot: string;
}

async function fixture(): Promise<Fixture> {
  const root = await workDir();
  const workspace = join(root, "app");
  const closureModulesDir = join(root, "closure", "node_modules");
  const seedRoot = join(root, "seed");
  await write(join(workspace, "package.json"), "{}\n");
  await write(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  await write(join(root, "app-sources", "local-pkg", "package.json"), '{ "name": "local-pkg" }\n');
  await write(join(root, "app-sources", "local-pkg", "dist", "index.js"), "");
  await write(join(closureModulesDir, "local-pkg", "package.json"), '{ "name": "local-pkg" }\n');
  await write(join(closureModulesDir, "local-pkg", "dist", "index.js"), "");

  await write(
    join(closureModulesDir, "installed-pkg", "package.json"),
    '{ "name": "installed-pkg", "version": "1.0.0" }\n',
  );
  await write(join(closureModulesDir, "installed-pkg", "index.js"), "");

  await write(join(seedRoot, "runtime", "package.json"), '{ "name": "runtime" }\n');
  await write(join(seedRoot, "profiles", "desktop", "package.json"), '{ "name": "profile" }\n');
  await write(join(seedRoot, "profiles", "desktop", "pnpm-workspace.yaml"), "packages:\n  - .\n");
  await write(
    join(seedRoot, "profiles", "desktop", "vendor", "@morlay", "better-session", "package.json"),
    '{ "name": "@morlay/better-session" }\n',
  );
  return { workspace, workspaceRoot: root, closureModulesDir, seedRoot };
}

async function fingerprint(input: Fixture): Promise<string> {
  return seedFingerprint({
    workspace: input.workspace,
    workspaceRoot: input.workspaceRoot,
    entries: ["package.json"],
    closureModulesDir: input.closureModulesDir,
    seedRoot: input.seedRoot,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("seed fingerprint", () => {
  it("changes when an installed package gains a file, at an unchanged version", async () => {
    const workspace = await fixture();
    const before = await fingerprint(workspace);

    await write(join(workspace.closureModulesDir, "installed-pkg", "index.cjs"), "");

    expect(await fingerprint(workspace)).not.toBe(before);

    await rm(join(workspace.closureModulesDir, "installed-pkg", "index.cjs"));
    expect(await fingerprint(workspace)).toBe(before);
  });

  it("changes when the planted profile manifest changes", async () => {
    const workspace = await fixture();
    const before = await fingerprint(workspace);

    await write(
      join(workspace.seedRoot, "profiles", "desktop", "package.json"),
      '{ "name": "other" }\n',
    );

    expect(await fingerprint(workspace)).not.toBe(before);
  });

  it("changes when the profile gains a vendor source", async () => {
    const workspace = await fixture();
    const before = await fingerprint(workspace);

    await write(
      join(
        workspace.seedRoot,
        "profiles",
        "desktop",
        "vendor",
        "@morlay",
        "dsh-preset",
        "package.json",
      ),
      '{ "name": "@morlay/dsh-preset" }\n',
    );

    expect(await fingerprint(workspace)).not.toBe(before);
  });

  it("ignores the runtime payload the closure inputs already cover", async () => {
    const workspace = await fixture();
    const before = await fingerprint(workspace);

    await write(join(workspace.seedRoot, "runtime", "node_modules", "pkg", "index.js"), "");

    expect(await fingerprint(workspace)).toBe(before);
  });
});
