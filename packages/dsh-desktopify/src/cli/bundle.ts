/**
 * Bundle the workspace into a static, unsigned desktop application for the
 * current platform: build the shell, prepare the Node.js runtime and the
 * profile seed, then run electron-builder `--dir` (unpacked application
 * directory — no signing, no notarization, no developer account).
 *
 * `--install` additionally installs the unpacked application into the
 * platform's application directory (macOS `/Applications`, Linux
 * `~/.local/lib` + a desktop entry, Windows `%LOCALAPPDATA%\Programs`).
 *
 * The workspace is read from `DSH_DESKTOP_WORKSPACE` (the CLI forwards its
 * positional argument there) and defaults to the current directory. The
 * shell configuration is written beside the executable as `appconfig.json`
 * and passed to the in-process electron-builder run.
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeAppConfig, type AppConfig } from "../appconfig.ts";
import { buildDesktopApp } from "./electron-builder.ts";
import { prepareIcons } from "./icon.ts";
import { runPrepareRuntime } from "./prepare-runtime.ts";
import { runPrepareSeed } from "./prepare-seed.ts";
import { buildShell } from "./shell.ts";
import {
  PROFILE_NAME,
  buildRoot,
  desktopConfig,
  resolveWorkspace,
  workspaceManifest,
} from "./workspace.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

/** Options for the `bundle` command. */
export interface BundleOptions {
  readonly workspace?: string;
  readonly dir: boolean;
  readonly install: boolean;
}

/** Install the unpacked application into the platform's application directory. */
function installApp(workspace: string, name: string): void {
  const buildRootDir = buildRoot(workspace);
  const artifacts = join(buildRootDir, "artifacts");
  if (process.platform === "darwin") {
    const source = join(artifacts, "mac-arm64", `${name}.app`);
    if (!existsSync(source)) throw new Error(`desktop bundle: missing built application ${source}`);
    const target = join("/Applications", `${name}.app`);
    rmSync(target, { recursive: true, force: true });
    // verbatimSymlinks 保留 .app 内相对链接（framework Current -> A 等），
    // 否则 cpSync 会改写为指向源产物的绝对路径。
    cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    console.log(`desktop bundle: installed ${target}`);
    return;
  }
  if (process.platform === "linux") {
    const source = join(artifacts, "linux-unpacked");
    if (!existsSync(source)) throw new Error(`desktop bundle: missing built application ${source}`);
    const target = join(homedir(), ".local", "lib", name);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    const applicationsDir = join(homedir(), ".local", "share", "applications");
    mkdirSync(applicationsDir, { recursive: true });
    writeFileSync(
      join(applicationsDir, `${name}.desktop`),
      [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${name}`,
        `Exec=${join(target, name)}`,
        "Terminal=false",
        "",
      ].join("\n"),
    );
    console.log(`desktop bundle: installed ${target} with desktop entry`);
    return;
  }
  if (process.platform === "win32") {
    const source = join(artifacts, "win-unpacked");
    if (!existsSync(source)) throw new Error(`desktop bundle: missing built application ${source}`);
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const target = join(localAppData, "Programs", name);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    console.log(`desktop bundle: installed ${target}`);
    return;
  }
  throw new Error(`desktop bundle: unsupported platform ${process.platform}`);
}

export async function runBundle(options: BundleOptions): Promise<void> {
  const workspace = resolve(options.workspace ?? resolveWorkspace());
  const manifest = workspaceManifest(workspace);
  const buildRootDir = buildRoot(workspace);
  const desktop = desktopConfig(manifest);
  const appConfig: AppConfig = {
    name: manifest.name,
    id: desktop.id,
    version: desktop.version,
    dshHome: desktop.dshHome,
    window: desktop.window,
    profile: PROFILE_NAME,
  };

  console.log(`desktop bundle: workspace ${workspace} (${appConfig.name}@${appConfig.version})`);
  await buildShell();
  await runPrepareRuntime({ workspace });
  await runPrepareSeed({ workspace });
  // 桌面图标：workspace 的 dsh.desktop.icon（SVG）→ 平台图标（mac icns /
  // linux png / win png），产物直接交给 electron-builder。
  const icons = await prepareIcons(workspace, buildRootDir, desktop.icon);

  // Shell runtime configuration carried as an extra resource (resourcesPath).
  mkdirSync(join(buildRootDir, "runtime"), { recursive: true });
  writeAppConfig(join(buildRootDir, "runtime"), appConfig);

  await buildDesktopApp({
    appRoot: APP_ROOT,
    buildRoot: buildRootDir,
    appConfig,
    icons,
    dir: options.dir,
  });
  console.log(`desktop bundle: artifacts in ${join(buildRootDir, "artifacts")}`);
  if (options.install) installApp(workspace, appConfig.name);
}
