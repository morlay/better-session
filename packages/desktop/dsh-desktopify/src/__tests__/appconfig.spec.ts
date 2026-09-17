import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAppConfig, PROFILE_NAME, writeAppConfig, type AppConfig } from "../appconfig.ts";
import { desktopConfig } from "../cli/workspace.ts";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-desktopify-appconfig-"));
  roots.push(root);
  return root;
}

async function write(value: unknown): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "appconfig.json"), `${JSON.stringify(value)}\n`);
  return dir;
}

function fullConfig(): AppConfig {
  return {
    name: "dsh-custom-next",
    id: "ai.deepseek.dsh.custom-next",
    version: "0.1.5",
    profile: PROFILE_NAME,
    dshHome: "env",
    window: { width: 1024, height: 768, minWidth: 640, minHeight: 480 },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("shell configuration handoff", () => {
  it("reads back exactly what the CLI wrote", async () => {
    const dir = await tempDir();
    const config = fullConfig();

    await writeAppConfig(dir, config);

    expect(await loadAppConfig(dir)).toEqual(config);
  });

  it("carries the workspace-derived configuration the CLI writes", async () => {
    const dir = await tempDir();
    const derived = desktopConfig({
      name: "dsh-custom",
      version: "0.1.5",
      dsh: { desktop: { id: "ai.deepseek.dsh.custom", dshHome: "xdg" } },
    });

    await writeAppConfig(dir, { name: "dsh-custom", ...derived, profile: PROFILE_NAME });

    expect(await loadAppConfig(dir)).toEqual({
      name: "dsh-custom",
      ...derived,
      profile: PROFILE_NAME,
    });
  });

  it("falls back to the default window geometry", async () => {
    const defaults = desktopConfig({ name: "dsh-custom" }).window;

    expect(
      (
        await loadAppConfig(
          await write({
            name: "a",
            id: "b",
            version: "1.0.0",
            profile: PROFILE_NAME,
            dshHome: "xdg",
          }),
        )
      ).window,
    ).toEqual(defaults);
    expect(
      (
        await loadAppConfig(
          await write({
            name: "a",
            id: "b",
            version: "1.0.0",
            profile: PROFILE_NAME,
            dshHome: "env",
            window: { width: 0, height: -1, minWidth: Number.NaN, minHeight: "800" },
          }),
        )
      ).window,
    ).toEqual(defaults);
  });

  it("keeps a valid partial window override", async () => {
    const loaded = await loadAppConfig(
      await write({
        name: "a",
        id: "b",
        version: "1.0.0",
        profile: PROFILE_NAME,
        dshHome: "xdg",
        window: { width: 1440 },
      }),
    );

    expect(loaded.window).toEqual({ ...desktopConfig({ name: "a" }).window, width: 1440 });
  });

  it("refuses a configuration the desktop shell cannot honour", async () => {
    const invalid: unknown[] = [
      { name: "", id: "b", version: "1.0.0", profile: PROFILE_NAME, dshHome: "xdg" },
      { name: "a", id: "", version: "1.0.0", profile: PROFILE_NAME, dshHome: "xdg" },
      { name: "a", id: "b", version: "", profile: PROFILE_NAME, dshHome: "xdg" },
      { name: "a", id: "b", version: "1.0.0", profile: "web", dshHome: "xdg" },
      { name: "a", id: "b", version: "1.0.0", profile: PROFILE_NAME, dshHome: 7 },
      { name: "a", id: "b", version: "1.0.0", profile: PROFILE_NAME },
      [],
    ];

    for (const value of invalid) {
      await expect(async () => await loadAppConfig(await write(value))).rejects.toThrow(
        /invalid shell configuration/u,
      );
    }
  });

  it("fails when the shell configuration is absent", async () => {
    await expect(async () => await loadAppConfig(await tempDir())).rejects.toThrow(/ENOENT/u);
  });
});
