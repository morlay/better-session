import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../appconfig.ts";
import { prepareShellAppDirectory } from "../cli/electron-builder.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-shell-app-"));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

function appConfig(): AppConfig {
  return {
    name: "dsh-custom-next",
    id: "ai.deepseek.dsh.custom-next",
    version: "0.1.5",
    profile: "desktop",
    dshHome: "xdg",
    window: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
  };
}

describe("prepareShellAppDirectory", () => {
  it("writes a self-contained shell project with an isolating workspace file", async () => {
    const appRoot = await workDir();
    const buildRoot = await workDir();
    await mkdir(join(appRoot, "dist"), { recursive: true });
    await writeFile(join(appRoot, "dist", "index.mjs"), "export {};\n");
    await writeFile(join(appRoot, "dist", "preload-app.cjs"), "module.exports = {};\n");
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify({ name: "@morlay/dsh-desktopify", description: "d", author: "a" })}\n`,
    );

    const appDir = await prepareShellAppDirectory({
      appRoot,
      buildRoot,
      appConfig: appConfig(),
      icons: {},
      dir: true,
    });

    expect(await exists(join(appDir, "pnpm-workspace.yaml"))).toBe(true);
    expect(await readFile(join(appDir, "pnpm-workspace.yaml"), "utf8")).toBe("packages: []\n");
    const manifest = JSON.parse(await readFile(join(appDir, "package.json"), "utf8")) as {
      main?: string;
      version?: string;
      dependencies?: unknown;
    };
    expect(manifest.main).toBe("dist/index.mjs");
    expect(manifest.version).toBe("0.1.5");
    expect(manifest.dependencies).toBeUndefined();
    expect(await exists(join(appDir, "dist", "preload-app.cjs"))).toBe(true);
  });
});
