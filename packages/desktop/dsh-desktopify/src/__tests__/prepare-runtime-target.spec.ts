import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPrepareRuntime } from "../cli/prepare-runtime.ts";

const ORIGINAL = {
  platform: process.env.DSH_DESKTOP_TARGET_PLATFORM,
  arch: process.env.DSH_DESKTOP_TARGET_ARCH,
};

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-desktopify-runtime-"));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (ORIGINAL.platform === undefined) delete process.env.DSH_DESKTOP_TARGET_PLATFORM;
  else process.env.DSH_DESKTOP_TARGET_PLATFORM = ORIGINAL.platform;
  if (ORIGINAL.arch === undefined) delete process.env.DSH_DESKTOP_TARGET_ARCH;
  else process.env.DSH_DESKTOP_TARGET_ARCH = ORIGINAL.arch;
});

describe("bundled runtime target", () => {
  it("refuses an unsupported platform before it writes or downloads anything", async () => {
    const workspace = await tempDir();
    process.env.DSH_DESKTOP_TARGET_PLATFORM = "solaris";

    await expect(runPrepareRuntime({ workspace })).rejects.toThrow(/unsupported platform solaris/u);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it("refuses an unsupported architecture", async () => {
    const workspace = await tempDir();
    process.env.DSH_DESKTOP_TARGET_PLATFORM = "linux";
    process.env.DSH_DESKTOP_TARGET_ARCH = "riscv64";

    await expect(runPrepareRuntime({ workspace })).rejects.toThrow(
      /unsupported architecture riscv64/u,
    );
  });

  it("treats a blank target platform as unsupported", async () => {
    process.env.DSH_DESKTOP_TARGET_PLATFORM = "";

    await expect(runPrepareRuntime({ workspace: await tempDir() })).rejects.toThrow(
      /unsupported platform/u,
    );
  });
});
