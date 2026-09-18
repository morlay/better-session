import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeAppConfig, type AppConfig } from "../appconfig.ts";
import { buildDesktopApp } from "./electron-builder.ts";
import { prepareIcons } from "./icon.ts";
import {
  OFFICE_SKILLS_DIR,
  officeSkillAssetsSource,
  prepareOfficeSkillAssets,
} from "./office-assets.ts";
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

export interface BundleOptions {
  readonly workspace?: string;
  readonly dir: boolean;
  readonly install: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function installApp(workspace: string, name: string): Promise<void> {
  const buildRootDir = buildRoot(workspace);
  const artifacts = join(buildRootDir, "artifacts");
  if (process.platform === "darwin") {
    const source = join(artifacts, "mac-arm64", `${name}.app`);
    if (!(await pathExists(source)))
      throw new Error(`desktop bundle: missing built application ${source}`);
    const target = join("/Applications", `${name}.app`);
    await rm(target, { recursive: true, force: true });

    await cp(source, target, { recursive: true, verbatimSymlinks: true });
    console.log(`desktop bundle: installed ${target}`);
    return;
  }
  if (process.platform === "linux") {
    const source = join(artifacts, "linux-unpacked");
    if (!(await pathExists(source)))
      throw new Error(`desktop bundle: missing built application ${source}`);
    const target = join(homedir(), ".local", "lib", name);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    const applicationsDir = join(homedir(), ".local", "share", "applications");
    await mkdir(applicationsDir, { recursive: true });
    await writeFile(
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
    if (!(await pathExists(source)))
      throw new Error(`desktop bundle: missing built application ${source}`);
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const target = join(localAppData, "Programs", name);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    console.log(`desktop bundle: installed ${target}`);
    return;
  }
  throw new Error(`desktop bundle: unsupported platform ${process.platform}`);
}

export async function runBundle(options: BundleOptions): Promise<void> {
  const workspace = resolve(options.workspace ?? resolveWorkspace());
  const manifest = await workspaceManifest(workspace);
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

  const icons = await prepareIcons(workspace, buildRootDir, desktop.icon);

  await mkdir(join(buildRootDir, "runtime"), { recursive: true });
  await prepareOfficeSkillAssets(
    officeSkillAssetsSource(),
    join(buildRootDir, "runtime", OFFICE_SKILLS_DIR),
  );
  await writeAppConfig(join(buildRootDir, "runtime"), appConfig);

  await buildDesktopApp({
    appRoot: APP_ROOT,
    buildRoot: buildRootDir,
    appConfig,
    icons,
    dir: options.dir,
  });
  console.log(`desktop bundle: artifacts in ${join(buildRootDir, "artifacts")}`);
  if (options.install) await installApp(workspace, appConfig.name);
}
