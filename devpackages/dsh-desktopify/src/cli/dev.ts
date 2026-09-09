/**
 * Development launcher: build the shell, prepare a disposable project that
 * links the current workspace (dsh CLI, desktop host, and the hoisted
 * dependency closure), then launch the unpackaged Electron shell against it.
 * The backend runs under the current Node.js executable in node mode
 * (`ELECTRON_RUN_AS_NODE=1`) with `--import=tsx/esm`, so the workspace's
 * TypeScript plugin sources load directly.
 *
 * `--web` runs the web mode instead: prepare the `web` profile (merged
 * bundles + mirrored dependency closure) and boot `dsh web` in the browser.
 *
 * The workspace is read from `DSH_DESKTOP_WORKSPACE` (the CLI forwards its
 * positional argument there) and defaults to the current directory. The
 * official `@deepseek-ai/*` dependency surface and the official profile
 * bundles are maintained by the tool; the app only declares its own
 * dependencies and bundles.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROFILE_NAME,
  buildRoot,
  desktopConfig,
  findWorkspaceRoot,
  mergedProfileBundles,
  packageVersion,
  resolveWorkspace,
  workspaceManifest,
} from "./workspace.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

function debugPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`desktop development: ${name} must be an integer from 1 through 65535`);
  }
  return port;
}

/** Resolve a tool dependency's package directory (workspace link or registry install). */
function dependencyDir(packageName: string): string {
  return dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`)));
}

/** The dsh CLI entry the profile boot and web server run from. */
function cliEntry(): string {
  return join(dependencyDir("@deepseek-ai/dsh"), "lib", "bin.js");
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

async function runPackageScript(script: string, cwd: string): Promise<void> {
  await run("pnpm", ["run", script], cwd);
}

function removeOwnedPath(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true });
    return;
  }
  unlinkSync(path);
}

function linkDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(realpathSync(source), destination, process.platform === "win32" ? "junction" : "dir");
}

/** Mirror the workspace virtual-hoist directory into the disposable project. */
function mirrorDependencyLinks(sourceRoot: string, destinationRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const source = join(sourceRoot, entry.name);
    if (entry.name.startsWith("@") && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true });
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
        linkDirectory(join(source, scoped.name), join(destinationRoot, entry.name, scoped.name));
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink())
      linkDirectory(source, join(destinationRoot, entry.name));
  }
}

/** Replace the disposable project with links to the current built workspace. */
function prepareDevelopmentProject(
  projectDir: string,
  repositoryRoot: string,
  workspace: string,
): string {
  const cliDir = dependencyDir("@deepseek-ai/dsh");
  const hostDir = dependencyDir("@deepseek-ai/dsh-desktop-host");
  const workspaceDependencyDir = join(repositoryRoot, "node_modules", ".pnpm", "node_modules");
  const manifest = workspaceManifest(workspace);
  const cliManifest = JSON.parse(
    readFileSync(join(cliDir, "package.json"), "utf8"),
  ) as PackageManifest;
  if (cliManifest.name !== "@deepseek-ai/dsh") {
    throw new Error(
      `desktop development: resolved @deepseek-ai/dsh must be the CLI package, found ${String(cliManifest.name)}`,
    );
  }
  if (!existsSync(workspaceDependencyDir)) {
    throw new Error(
      "desktop development: workspace dependency links are missing; run pnpm install",
    );
  }
  if (!existsSync(join(hostDir, "lib", "index.js"))) {
    throw new Error(
      "desktop development: vendor apps/desktop-host/lib/index.js is missing; run the vendor build",
    );
  }
  const officialDependencies: Record<string, string> = {
    "@deepseek-ai/dsh": cliManifest.version ?? "",
    "@deepseek-ai/dsh-desktop-host": packageVersion(join(hostDir, "package.json"), "desktop host"),
  };
  removeOwnedPath(projectDir);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
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
  writeFileSync(
    join(projectDir, "desktop.cordis.yml"),
    "# Development composition root; the launcher owns this file.\n[]\n",
  );
  const destinationModules = join(projectDir, "node_modules");
  mkdirSync(destinationModules, { recursive: true });
  mirrorDependencyLinks(workspaceDependencyDir, destinationModules);
  const dshLink = join(destinationModules, "@deepseek-ai", "dsh");
  removeOwnedPath(dshLink);
  linkDirectory(cliDir, dshLink);
  const hostLink = join(destinationModules, "@deepseek-ai", "dsh-desktop-host");
  removeOwnedPath(hostLink);
  linkDirectory(hostDir, hostLink);
  return projectDir;
}

/**
 * Prepare the `web` profile for browser mode: install the workspace's own
 * dependencies into `{workspace}/.dsh-store/profiles/web` with
 * `dsh plugin --profile web add <pkg>@link:<path>` (the upstream command
 * initializes the profile with the official bundles and reconciles the
 * bundle list). Returns the profile directory.
 */
async function prepareWebProfile(workspace: string): Promise<string> {
  const manifest = workspaceManifest(workspace);
  const home = join(workspace, ".dsh-store");
  const entry = cliEntry();
  if (!existsSync(entry)) {
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

/** Resolve a workspace dependency to its package directory (link target). */
function resolveLinkTarget(workspace: string, packageName: string): string {
  const require = createRequire(join(workspace, "package.json"));
  const resolved = require.resolve(packageName);
  // 包目录 = 解析入口的包根（exports 指向 src/index.ts 时取 src 上一级）。
  const marker = `${sep}src${sep}index`;
  const boundary = resolved.indexOf(marker);
  return boundary < 0 ? dirname(dirname(resolved)) : resolved.slice(0, boundary);
}

async function launchElectron(projectDir: string, buildRootDir: string): Promise<void> {
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
  // 后端用系统 node（非 Electron 内置 Node 24）：tsx 4.x 在 Node 24 的
  // strip-only 模式下不支持 parameter properties，morlay 的 TS 源码
  // （constructor(private readonly ...)）转换失败会导致 boot 卡死。
  const systemNode = process.env.DSH_DESKTOP_NODE_BINARY ?? process.env.npm_node_execpath ?? "node";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_DESKTOP_APPCONFIG_DIR: join(buildRootDir, "runtime"),
    DSH_DESKTOP_DEV_PROJECT_DIR: projectDir,
    DSH_DESKTOP_HOST_INSPECT_PORT: String(hostPort),
    DSH_DESKTOP_NODE_BINARY: systemNode,
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

/** Options for the `dev` command. */
export interface DevOptions {
  readonly workspace?: string;
  readonly web: boolean;
  readonly skipBuild: boolean;
}

export async function runDev(options: DevOptions): Promise<void> {
  const workspace = resolve(options.workspace ?? resolveWorkspace());
  const repositoryRoot = findWorkspaceRoot(workspace);
  const manifest = workspaceManifest(workspace);
  const buildRootDir = buildRoot(workspace);
  if (!options.skipBuild) {
    await runPackageScript("build", APP_ROOT);
  }
  if (options.web) {
    // web 模式：DSH_HOME 用 {workspace}/.dsh-store，依赖经
    // `dsh plugin --profile web add <pkg>@link:<path>` 装入 profile。
    const home = join(workspace, ".dsh-store");
    const profileDir = await prepareWebProfile(workspace);
    const port = process.env.PORT ?? "3080";
    const entry = cliEntry();
    if (!existsSync(entry)) {
      throw new Error(`desktop development: missing built artifact ${entry}`);
    }
    console.log(
      `desktop development: web mode DSH_HOME=${home} profile=${profileDir} port=${port}`,
    );
    await run(process.execPath, [entry, "web", "--port", port], repositoryRoot, {
      ...process.env,
      DSH_HOME: home,
      NODE_OPTIONS: "--import=tsx/esm",
    });
    return;
  }
  for (const path of [
    join(APP_ROOT, "lib", "main.js"),
    join(dependencyDir("@deepseek-ai/dsh-desktop-host"), "lib", "index.js"),
  ]) {
    if (!existsSync(path)) throw new Error(`desktop development: missing built artifact ${path}`);
  }
  const projectDir = prepareDevelopmentProject(
    join(buildRootDir, "development", "project"),
    repositoryRoot,
    workspace,
  );
  // 开发模式也携带 appconfig.json（窗口几何来自工作区 dsh.desktop.window）；
  // dshHome 固定 env——host 继承本脚本显式设置的 DSH_HOME（buildRoot 内）。
  mkdirSync(join(buildRootDir, "runtime"), { recursive: true });
  writeFileSync(
    join(buildRootDir, "runtime", "appconfig.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        ...desktopConfig(manifest),
        dshHome: "env",
        profile: PROFILE_NAME,
      },
      undefined,
      2,
    )}\n`,
  );
  await launchElectron(projectDir, buildRootDir);
}
