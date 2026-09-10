/**
 * Development launcher: build the shell, prepare a disposable project that
 * links the current workspace (dsh CLI, desktop host, and the dependency
 * closure), then launch the unpackaged Electron shell against it. The backend
 * runs under the current Node.js executable in node mode
 * (`ELECTRON_RUN_AS_NODE=1`) and loads the workspace's TypeScript plugin
 * sources through `--import=tsx/esm` — only when the workspace actually has
 * tsx installed.
 *
 * `--web` runs the web mode instead: prepare the `web` profile (merged
 * bundles + linked dependency closure) and boot `dsh web` in the browser.
 *
 * The workspace is read from `DSH_DESKTOP_WORKSPACE` (the CLI forwards its
 * positional argument there) and defaults to the current directory. The
 * official `@deepseek-ai/*` dependency surface and the official profile
 * bundles are maintained by the tool; the app declares its own dependencies,
 * its `dsh.version`, and its bundles. Official packages are resolved from the
 * app workspace first, so an app outside this repository works the same.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { writeAppConfig } from "../appconfig.ts";
import {
  DESKTOP_HOST_PACKAGE,
  DSH_PACKAGE,
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
  desktopConfig,
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

/** Official resolution context for one workspace (app first, then the tool). */
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

/** The dsh CLI entry the profile boot and web server run from. */
function cliEntry(input: OfficialResolutionInput): string {
  const dsh = resolveOfficialPackage(DSH_PACKAGE, input);
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

function linkDirectory(source: string, destination: string, skipExisting = false): void {
  if (skipExisting) {
    try {
      lstatSync(destination);
      return;
    } catch {
      // Missing: link it.
    }
  }
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(realpathSync(source), destination, process.platform === "win32" ? "junction" : "dir");
}

/** Mirror one dependency directory (virtual store or hoisted node_modules). */
function mirrorDependencyLinks(
  sourceRoot: string,
  destinationRoot: string,
  skipExisting = false,
): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    // 跳过安装簿记（.bin / .pnpm / .modules.yaml 等）。
    if (entry.name.startsWith(".")) continue;
    const source = join(sourceRoot, entry.name);
    if (entry.name.startsWith("@") && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true });
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
        linkDirectory(
          join(source, scoped.name),
          join(destinationRoot, entry.name, scoped.name),
          skipExisting,
        );
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink())
      linkDirectory(source, join(destinationRoot, entry.name), skipExisting);
  }
}

/** Replace the disposable project with links to the current built workspace. */
function prepareDevelopmentProject(
  projectDir: string,
  workspace: string,
  input: OfficialResolutionInput,
): string {
  const manifest = workspaceManifest(workspace);
  const dsh = resolveOfficialPackage(DSH_PACKAGE, input);
  const host = resolveOfficialPackage(DESKTOP_HOST_PACKAGE, input);
  if (dsh === undefined) throw new Error(`desktop development: cannot resolve ${DSH_PACKAGE}`);
  if (host === undefined)
    throw new Error(`desktop development: cannot resolve ${DESKTOP_HOST_PACKAGE}`);
  // 工作区闭包：优先 pnpm 虚拟存储（isolated 布局），否则回退到工作区自己的
  // node_modules（hoisted 布局，独立项目）。
  const virtualStore = join(input.workspaceRoot, "node_modules", ".pnpm", "node_modules");
  const workspaceDependencyDir = existsSync(virtualStore)
    ? virtualStore
    : join(workspace, "node_modules");
  if (!existsSync(workspaceDependencyDir)) {
    throw new Error(
      `desktop development: workspace dependency links are missing under ${workspaceDependencyDir}; run pnpm install`,
    );
  }
  if (!existsSync(join(host.dir, "lib", "index.js"))) {
    throw new Error(
      `desktop development: ${DESKTOP_HOST_PACKAGE} is not built (${join(host.dir, "lib", "index.js")} is missing)`,
    );
  }
  const officialDependencies = officialDependencySpecs(input);
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
  // 独立项目可能只声明 dsh.version 而未装官方包：用工具自身的官方树补齐。
  const toolStore = toolModulesDir(input);
  if (toolStore !== undefined && resolve(toolStore) !== resolve(workspaceDependencyDir)) {
    mirrorDependencyLinks(toolStore, destinationModules, true);
  }
  const dshLink = join(destinationModules, "@deepseek-ai", "dsh");
  removeOwnedPath(dshLink);
  linkDirectory(dsh.dir, dshLink);
  const hostLink = join(destinationModules, "@deepseek-ai", "dsh-desktop-host");
  removeOwnedPath(hostLink);
  linkDirectory(host.dir, hostLink);
  return projectDir;
}

/**
 * Prepare the `web` profile for browser mode: install the workspace's own
 * dependencies into `{workspace}/.dsh-store/profiles/web` with
 * `dsh plugin --profile web add <pkg>@link:<path>` (the upstream command
 * initializes the profile with the official bundles and reconciles the
 * bundle list). Returns the profile directory.
 */
async function prepareWebProfile(
  workspace: string,
  input: OfficialResolutionInput,
): Promise<string> {
  const manifest = workspaceManifest(workspace);
  const home = join(workspace, ".dsh-store");
  const entry = cliEntry(input);
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
    // 壳据此决定是否为 host 加 `--import=tsx/esm`：工作区没有 tsx 时留空。
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
  const input = officialInput(workspace, repositoryRoot, manifest);
  const buildRootDir = buildRoot(workspace);
  if (!options.skipBuild) {
    await buildShell();
  }
  if (options.web) {
    // web 模式：DSH_HOME 用 {workspace}/.dsh-store，依赖经
    // `dsh plugin --profile web add <pkg>@link:<path>` 装入 profile。
    const home = join(workspace, ".dsh-store");
    const profileDir = await prepareWebProfile(workspace, input);
    const port = process.env.PORT ?? "3080";
    const entry = cliEntry(input);
    if (!existsSync(entry)) {
      throw new Error(`desktop development: missing built artifact ${entry}`);
    }
    console.log(
      `desktop development: web mode DSH_HOME=${home} profile=${profileDir} port=${port}`,
    );
    // 工作区没有 tsx 时不注入 loader：morlay 插件已是 dist 产物，强制
    // `--import=tsx/esm` 会因解析失败而直接崩。
    const tsx = hasTsx(workspace, repositoryRoot);
    const nodeOptions = tsx
      ? [process.env.NODE_OPTIONS, "--import=tsx/esm"].filter(Boolean).join(" ")
      : process.env.NODE_OPTIONS;
    await run(process.execPath, [entry, "web", "--port", port], repositoryRoot, {
      ...process.env,
      DSH_HOME: home,
      ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }),
    });
    return;
  }
  if (!existsSync(SHELL_ENTRY)) {
    throw new Error(`desktop development: missing built artifact ${SHELL_ENTRY}`);
  }
  const projectDir = prepareDevelopmentProject(
    join(buildRootDir, "development", "project"),
    workspace,
    input,
  );
  // 开发模式也携带 appconfig.json（窗口几何来自工作区 dsh.desktop.window）；
  // dshHome 固定 env——host 继承本脚本显式设置的 DSH_HOME（buildRoot 内）。
  const desktop = desktopConfig(manifest);
  mkdirSync(join(buildRootDir, "runtime"), { recursive: true });
  writeAppConfig(join(buildRootDir, "runtime"), {
    name: manifest.name,
    id: desktop.id,
    version: desktop.version,
    dshHome: "env",
    window: desktop.window,
    profile: PROFILE_NAME,
  });
  // host 的 cwd 是 dev 项目；tsx 是否可用以项目内解析为准。
  await launchElectron(projectDir, buildRootDir, hasTsx(projectDir, projectDir));
}
