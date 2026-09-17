import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build, type CliOptions } from "electron-builder";
import type { AppConfig } from "../appconfig.ts";
import type { PreparedIcons } from "./icon.ts";

type DesktopConfiguration = Exclude<NonNullable<CliOptions["config"]>, string>;

interface ToolManifest {
  readonly name?: string;
  readonly description?: string;
  readonly author?: string;
}

export interface DesktopBuildOptions {
  readonly appRoot: string;

  readonly buildRoot: string;

  readonly appConfig: AppConfig;

  readonly icons: PreparedIcons;

  readonly dir: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function installedElectron(): Promise<{ readonly version: string; readonly dist?: string }> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("electron/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: string };
  if (typeof manifest.version !== "string") {
    throw new Error("dsh-desktopify: installed electron has no version");
  }
  const dist = join(dirname(manifestPath), "dist");
  return { version: manifest.version, ...((await pathExists(dist)) ? { dist } : {}) };
}

export async function prepareShellAppDirectory(options: DesktopBuildOptions): Promise<string> {
  const { appRoot, buildRoot, appConfig } = options;
  const appDir = join(buildRoot, "shell");
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  await cp(join(appRoot, "dist"), join(appDir, "dist"), { recursive: true });
  const renderer = join(appRoot, "renderer");
  if (await pathExists(renderer)) await cp(renderer, join(appDir, "renderer"), { recursive: true });
  await writeFile(join(appDir, "pnpm-workspace.yaml"), "packages: []\n");
  const tool = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as ToolManifest;
  await writeFile(
    join(appDir, "package.json"),
    `${JSON.stringify(
      {
        name: tool.name ?? "dsh-desktop-shell",
        version: appConfig.version,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.author === undefined ? {} : { author: tool.author }),
        main: "dist/index.mjs",
      },
      undefined,
      2,
    )}\n`,
  );
  return appDir;
}

export async function buildDesktopApp(options: DesktopBuildOptions): Promise<string[]> {
  const { buildRoot, appConfig, icons, dir } = options;
  const appDir = await prepareShellAppDirectory(options);
  const electron = await installedElectron();
  console.log(
    `desktop bundle: electron-builder appId=${appConfig.id} productName=${appConfig.name} version=${appConfig.version} electron=${electron.version}`,
  );
  const config: DesktopConfiguration = {
    appId: appConfig.id,
    productName: appConfig.name,
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    electronVersion: electron.version,
    ...(electron.dist === undefined ? {} : { electronDist: electron.dist }),
    directories: { output: join(buildRoot, "artifacts") },
    asar: true,
    files: ["dist/**", "renderer/**/*", "package.json"],
    extraResources: [
      { from: join(buildRoot, "runtime"), to: "runtime" },
      { from: join(buildRoot, "seed"), to: "seed" },
      { from: join(buildRoot, "runtime", "appconfig.json"), to: "appconfig.json" },
    ],
    mac: {
      category: "public.app-category.developer-tools",
      identity: null,
      target: ["dir"],
      ...(icons.mac === undefined ? {} : { icon: icons.mac }),
    },
    linux: {
      category: "Development",
      target: ["dir"],
      ...(icons.linux === undefined ? {} : { icon: icons.linux }),
    },
    win: {
      target: ["dir"],
      ...(icons.win === undefined ? {} : { icon: icons.win }),
    },
  };
  return build({ projectDir: appDir, config, publish: "never", dir });
}
