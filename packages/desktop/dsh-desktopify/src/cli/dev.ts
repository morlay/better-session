import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { writeAppConfig } from "../appconfig.ts";
import { discoverPresetMounts, materializeAgentPresets } from "./agent-presets.ts";
import { ensureClientBundlePlaceholders, installProfilePatch } from "./dev-web.ts";
import {
  OFFICE_SKILLS_DIR,
  officeSkillAssetsSource,
  prepareOfficeSkillAssets,
} from "./office-assets.ts";
import {
  DESKTOP_HOST_PACKAGE,
  DSH_PACKAGE,
  desktopHost,
  hasTsx,
  officialDependencySpecs,
  resolveOfficialPackage,
  toolModulesDir,
  type OfficialResolutionInput,
} from "./official-deps.ts";
import { buildShell, SHELL_ENTRY } from "./shell.ts";
import {
  PROFILE_NAME,
  buildRoot,
  desktopAgentPresets,
  desktopConfig,
  devWebConfig,
  dshVersion as readDshVersion,
  findWorkspaceRoot,
  mergedProfileBundles,
  resolveWorkspace,
  workspaceManifest,
  type ResolvedWorkspaceManifest,
} from "./workspace.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

function debugPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`desktop development: ${name} must be an integer from 1 through 65535`);
  }
  return port;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function officialInput(
  workspace: string,
  workspaceRoot: string,
  manifest: ResolvedWorkspaceManifest,
): OfficialResolutionInput {
  const dshVersion = readDshVersion(manifest);
  return {
    workspace,
    workspaceRoot,
    toolRoot: APP_ROOT,
    ...(dshVersion === undefined ? {} : { dshVersion }),
  };
}

async function cliEntry(input: OfficialResolutionInput): Promise<string> {
  const dsh = await resolveOfficialPackage(DSH_PACKAGE, input);
  if (dsh === undefined) {
    throw new Error(`desktop development: cannot resolve ${DSH_PACKAGE}`);
  }
  return join(dsh.dir, "lib", "bin.js");
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment = process.env,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`desktop development: ${args.join(" ")} exited with ${String(code ?? signal)}`),
        );
    });
  });
}

async function removeOwnedPath(path: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (stat.isDirectory()) {
    await rm(path, { recursive: true });
    return;
  }
  await unlink(path);
}

async function linkDirectory(
  source: string,
  destination: string,
  skipExisting = false,
): Promise<void> {
  if (skipExisting) {
    try {
      await lstat(destination);
      return;
    } catch {}
  }
  await mkdir(dirname(destination), { recursive: true });
  await symlink(
    await realpath(source),
    destination,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function mirrorDependencyLinks(
  sourceRoot: string,
  destinationRoot: string,
  skipExisting = false,
): Promise<void> {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const source = join(sourceRoot, entry.name);
    if (entry.name.startsWith("@") && (entry.isDirectory() || entry.isSymbolicLink())) {
      await mkdir(join(destinationRoot, entry.name), { recursive: true });
      for (const scoped of await readdir(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
        await mirrorOneLink(
          join(source, scoped.name),
          join(destinationRoot, entry.name, scoped.name),
          skipExisting,
        );
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink())
      await mirrorOneLink(source, join(destinationRoot, entry.name), skipExisting);
  }
}

async function mirrorOneLink(
  source: string,
  destination: string,
  skipExisting: boolean,
): Promise<void> {
  if (!(await pathExists(source))) return;
  await linkDirectory(source, destination, skipExisting);
}

async function prepareDevelopmentProject(
  projectDir: string,
  workspace: string,
  input: OfficialResolutionInput,
): Promise<string> {
  const manifest = await workspaceManifest(workspace);
  const dsh = await resolveOfficialPackage(DSH_PACKAGE, input);
  const host = await desktopHost();
  if (dsh === undefined) throw new Error(`desktop development: cannot resolve ${DSH_PACKAGE}`);
  if (host === undefined) {
    throw new Error(
      `desktop development: bundled ${DESKTOP_HOST_PACKAGE} is missing; run the tool build (pnpm build)`,
    );
  }

  const virtualStore = join(input.workspaceRoot, "node_modules", ".pnpm", "node_modules");
  const workspaceDependencyDir = (await pathExists(virtualStore))
    ? virtualStore
    : join(workspace, "node_modules");
  if (!(await pathExists(workspaceDependencyDir))) {
    throw new Error(
      `desktop development: workspace dependency links are missing under ${workspaceDependencyDir}; run pnpm install`,
    );
  }
  if (!(await pathExists(join(host.dir, "lib", "index.js")))) {
    throw new Error(
      `desktop development: ${DESKTOP_HOST_PACKAGE} is not built (${join(host.dir, "lib", "index.js")} is missing)`,
    );
  }
  const officialDependencies = await officialDependencySpecs(input);
  await removeOwnedPath(projectDir);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "package.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        private: true,
        version: "0.0.0",
        dependencies: officialDependencies,
        dsh: { profile: { bundles: mergedProfileBundles(manifest) } },
      },
      undefined,
      2,
    )}\n`,
  );
  const destinationModules = join(projectDir, "node_modules");
  await mkdir(destinationModules, { recursive: true });
  await mirrorDependencyLinks(workspaceDependencyDir, destinationModules);

  const toolStore = await toolModulesDir(input);
  if (toolStore !== undefined && resolve(toolStore) !== resolve(workspaceDependencyDir)) {
    await mirrorDependencyLinks(toolStore, destinationModules, true);
  }
  const dshLink = join(destinationModules, "@deepseek-ai", "dsh");
  await removeOwnedPath(dshLink);
  await copyPackage(dsh.dir, dshLink);
  const hostLink = join(destinationModules, "@deepseek-ai", "dsh-desktop-host");
  await removeOwnedPath(hostLink);
  await copyPackage(host.dir, hostLink);
  await materializeAgentPresets(
    projectDir,
    await discoverPresetMounts(manifest, destinationModules, desktopAgentPresets(manifest)),
  );
  return projectDir;
}

async function copyPackage(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: true,

    filter: (entry) => {
      const rel = relative(source, entry);
      return rel === "" || !rel.split(/[\\/]/u).includes("node_modules");
    },
  });
}

async function prepareWebProfile(
  workspace: string,
  input: OfficialResolutionInput,
): Promise<string> {
  const manifest = await workspaceManifest(workspace);
  const home = join(workspace, ".dsh-store");
  const entry = await cliEntry(input);
  if (!(await pathExists(entry))) {
    throw new Error(`desktop development: missing built artifact ${entry}`);
  }
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    const link = resolveLinkTarget(workspace, packageName);
    await run(
      process.execPath,
      [entry, "plugin", "--profile", "web", "add", `${packageName}@link:${link}`],
      workspace,
      {
        ...process.env,
        DSH_HOME: home,
      },
    );
  }
  return join(home, "profiles", "web");
}

function resolveLinkTarget(workspace: string, packageName: string): string {
  const require = createRequire(join(workspace, "package.json"));
  const resolved = require.resolve(packageName);

  const marker = `${sep}src${sep}index`;
  const boundary = resolved.indexOf(marker);
  return boundary < 0 ? dirname(dirname(resolved)) : resolved.slice(0, boundary);
}

async function launchElectron(
  projectDir: string,
  buildRootDir: string,
  tsxImport: boolean,
): Promise<void> {
  const require = createRequire(import.meta.url);
  const electron: unknown = require("electron");
  if (typeof electron !== "string")
    throw new Error("desktop development: electron executable is unavailable");
  const mainPort = debugPort("DSH_DESKTOP_MAIN_INSPECT_PORT", 9229);
  const rendererPort = debugPort("DSH_DESKTOP_RENDERER_DEBUG_PORT", 9222);
  const hostPort = debugPort("DSH_DESKTOP_HOST_INSPECT_PORT", 9230);
  const developmentRoot = join(buildRootDir, "development");
  const home = resolve(join(developmentRoot, "home"));
  const userData = join(developmentRoot, "electron-user-data");

  const systemNode = process.env.DSH_DESKTOP_NODE_BINARY ?? process.env.npm_node_execpath ?? "node";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_DESKTOP_APPCONFIG_DIR: join(buildRootDir, "runtime"),
    DSH_DESKTOP_DEV_PROJECT_DIR: projectDir,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(buildRootDir, "runtime", "primary-runtime"),
    DSH_DESKTOP_HOST_INSPECT_PORT: String(hostPort),
    DSH_DESKTOP_NODE_BINARY: systemNode,

    DSH_DESKTOP_TSX_IMPORT: tsxImport ? "tsx/esm" : "",
    DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? "1",
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? "1",
  };
  console.log(`desktop development: DSH_HOME=${home}`);
  console.log(
    `desktop development: inspectors main=${String(mainPort)}, renderer=${String(rendererPort)}, host=${String(hostPort)}`,
  );
  await run(
    electron,
    [
      `--inspect=127.0.0.1:${String(mainPort)}`,
      `--remote-debugging-port=${String(rendererPort)}`,
      `--user-data-dir=${userData}`,
      APP_ROOT,
    ],
    APP_ROOT,
    environment,
  );
}

export interface DevOptions {
  readonly workspace?: string;
  readonly web: boolean;
}

export async function runDev(options: DevOptions): Promise<void> {
  const workspace = resolve(options.workspace ?? resolveWorkspace());
  const repositoryRoot = await findWorkspaceRoot(workspace);
  const manifest = await workspaceManifest(workspace);
  const input = officialInput(workspace, repositoryRoot, manifest);
  const buildRootDir = buildRoot(workspace);
  await buildShell();
  if (options.web) {
    const home = join(workspace, ".dsh-store");
    const profileDir = await prepareWebProfile(workspace, input);
    const port = process.env.PORT ?? "3080";
    const entry = await cliEntry(input);
    if (!(await pathExists(entry))) {
      throw new Error(`desktop development: missing built artifact ${entry}`);
    }
    console.log(
      `desktop development: web mode DSH_HOME=${home} profile=${profileDir} port=${port}`,
    );

    const devWeb = devWebConfig(manifest);
    if (devWeb !== undefined) {
      const patchFile = await installProfilePatch(profileDir, workspace);
      const placeholders = await ensureClientBundlePlaceholders(profileDir, devWeb);
      console.log(
        `desktop development: dev client bundles patch=${patchFile} ` +
          `placeholders=${placeholders.length === 0 ? "none" : placeholders.join(", ")}`,
      );
    }

    const tsx = hasTsx(workspace, repositoryRoot);
    const nodeOptions = tsx
      ? [process.env.NODE_OPTIONS, "--import=tsx/esm"].filter(Boolean).join(" ")
      : process.env.NODE_OPTIONS;
    await run(process.execPath, [entry, "web", "--port", port], repositoryRoot, {
      ...process.env,
      DSH_HOME: home,

      ...(devWeb === undefined ? {} : { DSH_DEV_CLIENT_BUNDLES: "1" }),
      ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }),
    });
    return;
  }
  if (!(await pathExists(SHELL_ENTRY))) {
    throw new Error(`desktop development: missing built artifact ${SHELL_ENTRY}`);
  }
  const projectDir = await prepareDevelopmentProject(
    join(buildRootDir, "development", "project"),
    workspace,
    input,
  );
  const desktop = desktopConfig(manifest);
  const runtimeRoot = join(buildRootDir, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  await prepareOfficeSkillAssets(officeSkillAssetsSource(), join(runtimeRoot, OFFICE_SKILLS_DIR));
  await writeAppConfig(runtimeRoot, {
    name: manifest.name,
    id: desktop.id,
    version: desktop.version,
    dshHome: "env",
    window: desktop.window,
    profile: PROFILE_NAME,
  });

  await launchElectron(projectDir, buildRootDir, hasTsx(projectDir, projectDir));
}
