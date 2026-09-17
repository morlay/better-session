import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../appconfig.ts";
import { resolveDshHome, xdgDataHome } from "../dshhome.ts";

const ORIGINAL = {
  override: process.env.DSH_APP_DSH_HOME,
  xdg: process.env.XDG_DATA_HOME,
};

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-desktopify-home-"));
  roots.push(root);
  return root;
}

function config(dshHome: string, name = "dsh-custom"): AppConfig {
  return {
    name,
    id: "ai.deepseek.dsh.custom",
    version: "0.1.5",
    profile: "desktop",
    dshHome,
    window: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (ORIGINAL.override === undefined) delete process.env.DSH_APP_DSH_HOME;
  else process.env.DSH_APP_DSH_HOME = ORIGINAL.override;
  if (ORIGINAL.xdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = ORIGINAL.xdg;
});

describe("xdgDataHome", () => {
  it.skipIf(process.platform !== "darwin")(
    "uses the macOS application support directory and ignores XDG_DATA_HOME",
    async () => {
      process.env.XDG_DATA_HOME = await tempDir();

      expect(xdgDataHome()).toBe(join(homedir(), "Library", "Application Support"));
    },
  );

  it.skipIf(process.platform === "darwin")(
    "honours XDG_DATA_HOME and otherwise falls back to ~/.local/share",
    async () => {
      const configured = await tempDir();
      process.env.XDG_DATA_HOME = configured;
      expect(xdgDataHome()).toBe(normalize(configured));

      process.env.XDG_DATA_HOME = "   ";
      expect(xdgDataHome()).toBe(join(homedir(), ".local", "share"));

      delete process.env.XDG_DATA_HOME;
      expect(xdgDataHome()).toBe(join(homedir(), ".local", "share"));
    },
  );
});

describe("resolveDshHome", () => {
  it("appends the app name to the platform data home for xdg", () => {
    delete process.env.DSH_APP_DSH_HOME;

    expect(resolveDshHome(config("xdg"))).toBe(join(xdgDataHome(), "dsh-custom"));
  });

  it("reports no concrete home for env mode", () => {
    delete process.env.DSH_APP_DSH_HOME;

    expect(resolveDshHome(config("env"))).toBeUndefined();
  });

  it("takes an absolute path as-is", async () => {
    delete process.env.DSH_APP_DSH_HOME;
    const explicit = join(await tempDir(), "home");

    expect(resolveDshHome(config(explicit))).toBe(explicit);
  });

  it("lets the environment override every configuration", async () => {
    const override = await tempDir();
    process.env.DSH_APP_DSH_HOME = override;
    expect(resolveDshHome(config("xdg"))).toBe(override);
    expect(resolveDshHome(config("env"))).toBe(override);

    process.env.DSH_APP_DSH_HOME = "   ";
    expect(resolveDshHome(config("env"))).toBeUndefined();
    expect(resolveDshHome(config("xdg"))).toBe(join(xdgDataHome(), "dsh-custom"));
  });

  it("rejects a non-absolute path that is not a known mode", () => {
    delete process.env.DSH_APP_DSH_HOME;

    expect(() => resolveDshHome(config(`.${sep}data`))).toThrow(
      /dshHome must be xdg, env, or an absolute path/u,
    );
    expect(() => resolveDshHome(config("~/data"))).toThrow(
      /dshHome must be xdg, env, or an absolute path/u,
    );
  });
});
