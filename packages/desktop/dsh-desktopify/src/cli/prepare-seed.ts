/**
 * Build the packaged profile seed: export the workspace's production
 * dependency closure with `pnpm deploy`, then assemble `dsh-home/profiles/desktop`
 * from the workspace whitelist (package.json, cordis.patch.yml, declared
 * `files`) plus the flattened closure as `node_modules`, stamped with a
 * `.seed-hash` fingerprint. The shell forces the runtime home's profile to
 * this seed at startup.
 *
 * The fingerprint covers what can change under a bundled application without
 * a version bump: the whitelisted workspace content, the root lockfile (the
 * resolved dependency graph), the closure structure, the content of every local
 * source package, and the file listing of every installed package. Local
 * sources matter because `workspace:^` dependencies resolve to the workspace
 * tree (`@morlay/*`, vendored `@deepseek-ai/*`), so their content can change
 * while every version string stays the same; installed packages keep their
 * version but which of their files the tool copies into the closure is the
 * tool's own decision.
 *
 * The app's manifest and the root lockfile are never rewritten: `pnpm deploy`
 * runs against the workspace as declared, and the official `@deepseek-ai/*`
 * surface (dsh, the bundled desktop host, the peer whitelist, and everything
 * they reach) enters the deployed closure afterwards in two ways: pnpm installs
 * its registry part from the deploy project's own manifest, and the closure
 * walk copies what pnpm cannot install there (local source packages and the
 * bundled host, both carrying `workspace:` dependencies of the app's workspace).
 * The deploy project is the tool's own artifact — the one manifest it writes:
 * it inherits the workspace settings `pnpm deploy` leaves behind, so the closure
 * is complete while the workspace stays read-only. The seed then carries that
 * closure as `node_modules`.
 */

import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import {
  cpSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SEED_HASH_NAME } from "../seed.ts";

import { discoverPresetMounts, materializeAgentPresets } from "./agent-presets.ts";
import {
  DSH_PACKAGE,
  closurePackageDirs,
  materializeOfficialClosure,
  missingOfficialPackages,
  officialDeploySpecs,
  resolveOfficialPackage,
  type OfficialResolutionInput,
} from "./official-deps.ts";
import {
  PROFILE_NAME,
  buildRoot,
  desktopAgentPresets,
  dshVersion as readDshVersion,
  findWorkspaceRoot,
  mergedDeploySettings,
  mergedProfileBundles,
  resolveWorkspace,
  workspaceManifest,
} from "./workspace.ts";

/** 工具包根（源码形态 `src/cli` 与构建形态 `dist/cli` 同深度）。 */
const APP_ROOT = resolve(import.meta.dirname, "..", "..");

function runPnpm(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`desktop seed: pnpm ${args.join(" ")} exited with ${String(code ?? signal)}`),
        );
    });
  });
}

/**
 * Carry the workspace settings `pnpm deploy` leaves out of the deploy project's
 * manifest over to it. The deploy project is its own workspace (`pnpm deploy`
 * writes the manifest holding the settings an install must honour), and pnpm
 * resolves settings there from that workspace alone: a workspace-wide
 * `minimumReleaseAge: 0` missing there falls back to pnpm's default and makes
 * the next install refuse official versions published minutes ago. Missing
 * either side means there is nothing to merge.
 */
function inheritDeploySettings(root: string, destination: string): void {
  const sourcePath = join(root, "pnpm-workspace.yaml");
  const targetPath = join(destination, "pnpm-workspace.yaml");
  if (!existsSync(sourcePath) || !existsSync(targetPath)) return;
  const target = readFileSync(targetPath, "utf8");
  const merged = mergedDeploySettings(readFileSync(sourcePath, "utf8"), target);
  if (merged !== target) writeFileSync(targetPath, merged);
}

/**
 * Materialize the official registry surface inside the deploy project: write
 * the specs pnpm can resolve there into the deployed manifest (the deploy
 * project is the tool's artifact, the only manifest the tool may write — the
 * app workspace stays read-only) and install once, so pnpm owns the file-set
 * semantics: npm always packs `main`, `bin`, README and LICENSE, whatever
 * `files` declares.
 *
 * `pnpm deploy` can leave peer-shaped specs in the deployed manifest
 * (`"@morlay/dsh-preset": "0.0.1(faf77f80…)"`); no registry accepts that shape,
 * so strip it before re-resolving. An app targeting `workspace:` sources has
 * nothing installable here and is materialized by the closure walk instead.
 */
async function installOfficialSurface(
  destination: string,
  input: OfficialResolutionInput,
): Promise<void> {
  const pin = resolveOfficialPackage(DSH_PACKAGE, input)?.version ?? input.dshVersion;
  const specs = officialDeploySpecs(
    input,
    pin === undefined || pin.startsWith("workspace:") ? undefined : pin,
  );
  const names = Object.keys(specs);
  if (names.length === 0) return;
  const manifestPath = join(destination, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = new Map(
    Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => [
      name,
      spec.replace(/\([^()]*\)$/u, ""),
    ]),
  );
  for (const [name, spec] of Object.entries(specs)) dependencies.set(name, spec);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        dependencies: Object.fromEntries([...dependencies].sort(([a], [b]) => (a < b ? -1 : 1))),
      },
      undefined,
      2,
    )}\n`,
  );
  await runPnpm(["install", "--prod", "--ignore-scripts"], destination);
  console.log(
    `desktop seed: installed ${String(names.length)} official registry packages into the deploy project`,
  );
}

/**
 * Export the workspace production closure into the deploy staging directory.
 * The app's manifest and the root lockfile are read, never written: the deploy
 * runs against the app as declared, and the official surface enters the closure
 * afterwards — pnpm installs its registry part from the deploy project's own
 * manifest (`installOfficialSurface`), and the closure walk copies what pnpm
 * cannot install there (local source packages, the bundled desktop host). The
 * deploy project itself is the tool's own artifact: it inherits the workspace
 * settings before anything installs in it (`inheritDeploySettings`).
 */
async function deployClosure(
  workspace: string,
  name: string,
  destination: string,
  input: OfficialResolutionInput,
): Promise<void> {
  const root = findWorkspaceRoot(workspace);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const args = root !== resolve(workspace) ? ["--filter", name] : [];
  await runPnpm([...args, "deploy", "--prod", "--ignore-scripts", destination], root);
  const modulesDir = join(destination, "node_modules");
  if (!existsSync(modulesDir)) {
    throw new Error(`desktop seed: pnpm deploy did not produce ${modulesDir}`);
  }
  // 部署项目是它自己的 workspace：先继承工作区设置（minimumReleaseAge 等），
  // 再让 pnpm 装官方 registry 面（否则默认供应链策略会拒掉刚发布的版本）。
  inheritDeploySettings(root, destination);
  await installOfficialSurface(destination, input);
  // 闭包按部署项目的 nodeLinker 落地（继承工作区的设置，pnpm 默认 isolated）：
  // pnpm 装好的（app 自己的依赖树 + 官方 registry 面）不动，剩余官方包由工具按包
  // 解析补进闭包；冲突时保留 pnpm 的解析结果。
  // 顶层按包名可达：isolated 布局里传递依赖只在 `.pnpm` 虚拟存储内，而运行期
  // loader 从 profile 根解析包名（如 @morlay/session-branch），缺链接就找不到
  // —— linkClosureTopLevel 给每个 `.pnpm` 包补一条顶层相对链接。
  // 曾经试过把目标目录重排成 hoisted：那要求把本地 workspace 包 staging 成成员，
  // 随之而来的嵌套 node_modules 与中间目录链接会让运行期解析错位（加载到
  // `src/*.ts`），已移除。
  linkClosureTopLevel(modulesDir);
  const copied = materializeOfficialClosure(modulesDir, input);
  console.log(`desktop seed: copied ${String(copied.length)} official source packages`);
  // deploy 不装 peerDependencies：上游新增 peer 包只会在运行期炸开，
  // 这里提前失败并指名要补的白名单项。
  const missing = missingOfficialPackages(modulesDir);
  if (missing.size > 0) {
    const detail = [...missing]
      .map(([packageName, requiredBy]) => `${packageName} (required by ${requiredBy.join(", ")})`)
      .join("; ");
    throw new Error(
      `desktop seed: deployed closure is missing official packages: ${detail}; ` +
        "add them to OFFICIAL_PEER_PACKAGES (packages/desktop/dsh-desktopify/src/official.ts)",
    );
  }
}

/** 为 `.pnpm` 里的每个包补一条顶层相对链接（已存在的顶层条目不动）。 */
function linkClosureTopLevel(modulesDir: string): void {
  const store = join(modulesDir, ".pnpm");
  if (!existsSync(store)) return;
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inner = join(store, entry.name, "node_modules");
    if (!existsSync(inner)) continue;
    for (const [name, dir] of closurePackageDirs(inner)) {
      const link = join(modulesDir, ...name.split("/"));
      if (existsSync(link)) continue;
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(relative(dirname(link), dir), link, "dir");
    }
  }
}

/** Whitelisted workspace files that enter the seed and the fingerprint. */
function seedEntries(workspace: string, manifest: { files?: string[] }): string[] {
  const entries = new Set(["package.json", "cordis.patch.yml"]);
  for (const file of manifest.files ?? []) {
    const cleaned = file.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (cleaned === "" || cleaned === "." || cleaned.startsWith("/") || cleaned.startsWith("../"))
      continue;
    entries.add(cleaned);
  }
  return [...entries].sort();
}

/** Directories never walked when hashing seed content (installs, caches, VCS). */
const TREE_SKIP_DIRS = new Set([
  ".bin",
  ".cache",
  ".git",
  ".dsh-store",
  ".pnpm-store",
  ".turbo",
  "node_modules",
]);

/** Depth limit for the local package scan (vendored trees nest a few levels). */
const LOCAL_PACKAGE_SCAN_DEPTH = 6;

/** Feed one path (file, or directory expanded recursively) into the hash. */
function hashPath(hash: Hash, root: string, relativePath: string): void {
  const path = join(root, ...relativePath.split("/"));
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (TREE_SKIP_DIRS.has(entry)) continue;
      hashPath(hash, root, `${relativePath}/${entry}`);
    }
    return;
  }
  if (!stat.isFile()) return;
  hash.update(relativePath);
  hash.update("\0");
  hash.update(readFileSync(path));
  hash.update("\0");
}

/** Read a package name, tolerating unreadable or nameless manifests. */
function packageName(manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/** Local source packages under the workspace root: package name → directory. */
function localPackageDirs(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > LOCAL_PACKAGE_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: skip.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || TREE_SKIP_DIRS.has(entry.name))
        continue;
      const child = join(dir, entry.name);
      const manifestPath = join(child, "package.json");
      if (existsSync(manifestPath)) {
        const name = packageName(manifestPath);
        if (name !== undefined && !found.has(name)) found.set(name, child);
        // 继续下钻：容器目录（如 vendor/<harness>）自身也带 package.json，
        // 其下才是真正的包。
      }
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

/**
 * Sorted relative paths of every directory and file below one package
 * directory (names only, no contents; nested `node_modules` skipped, as they
 * never enter a closure).
 */
function packageEntries(dir: string): string[] {
  const found: string[] = [];
  const visit = (current: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: skip.
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      found.push(path);
      if (entry.isDirectory()) visit(join(current, entry.name), path);
    }
  };
  visit(dir, "");
  return found.sort();
}

/**
 * Seed fingerprint: whitelisted workspace content, the root lockfile (the
 * resolved dependency graph), the closure structure, the content of every local
 * source package, and the file listing of every installed package. A local
 * source package (`workspace:^` dependencies) keeps its version while its
 * content changes, so its content is the only reliable signal; an installed
 * package's content is pinned by its version, but which of its files the tool
 * copies into the closure is the tool's own decision, so the listing has to
 * count as well.
 */
export function seedFingerprint(input: {
  readonly workspace: string;
  readonly workspaceRoot: string;
  readonly entries: readonly string[];
  readonly closureModulesDir: string;
}): string {
  const hash = createHash("sha256");
  hash.update("workspace\0");
  for (const entry of input.entries) hashPath(hash, input.workspace, entry);
  hash.update("lockfile\0");
  const lockfile = join(input.workspaceRoot, "pnpm-lock.yaml");
  if (existsSync(lockfile)) {
    hash.update(readFileSync(lockfile));
    hash.update("\0");
  }
  // 闭包结构（顶层包名集合）也算指纹：布局/链接变化不改变任何包的源码内容，
  // 但会改变运行期解析结果，指纹必须跟着变，否则壳会跳过 profile 替换。
  const closure = closurePackageDirs(input.closureModulesDir);
  hash.update("closure\0");
  for (const name of closure.keys()) {
    hash.update(`${name}\0`);
  }
  hash.update("local-closure\0");
  const local = localPackageDirs(input.workspaceRoot);
  for (const name of closure.keys()) {
    if (!local.has(name)) continue;
    hash.update(`${name}\0`);
    hashPath(hash, input.closureModulesDir, name);
  }
  // 安装产物：内容由版本唯一确定，但**工具选哪些文件进闭包**会变（白名单误伤过
  // registry 包，闭包少了运行期入口），所以只喂路径清单（readdir，不读内容）。
  hash.update("installed-closure\0");
  for (const [name, dir] of closure) {
    if (local.has(name)) continue;
    hash.update(`${name}\0`);
    for (const entry of packageEntries(dir)) hash.update(`${entry}\0`);
  }
  return hash.digest("hex");
}

/** Options for the profile-seed preparation step of `bundle`. */
export interface PrepareSeedOptions {
  readonly workspace?: string;
}

export async function runPrepareSeed(options: PrepareSeedOptions): Promise<void> {
  const workspace = resolve(options.workspace ?? resolveWorkspace());
  const manifest = workspaceManifest(workspace);
  const workspaceRoot = findWorkspaceRoot(workspace);
  const dshVersion = readDshVersion(manifest);
  const input: OfficialResolutionInput = {
    workspace,
    workspaceRoot,
    toolRoot: APP_ROOT,
    ...(dshVersion === undefined ? {} : { dshVersion }),
  };
  const buildRootDir = buildRoot(workspace);
  const seedOutputRoot = join(buildRootDir, "seed");
  const deployRoot = join(buildRootDir, "deploy");
  const entries = seedEntries(workspace, manifest);
  console.log(`desktop seed: workspace ${workspace} (${manifest.name})`);
  console.log(`desktop seed: whitelist ${entries.join(", ")}`);

  await deployClosure(workspace, manifest.name, deployRoot, input);
  // 指纹覆盖闭包内容：workspace:^ 依赖（morlay 包 / vendor 源码）版本号不变
  // 也可能变化，必须对 deploy 产物本身取指纹。
  const fingerprint = seedFingerprint({
    workspace,
    workspaceRoot,
    entries,
    closureModulesDir: join(deployRoot, "node_modules"),
  });

  rmSync(seedOutputRoot, { recursive: true, force: true });
  const profileDir = join(seedOutputRoot, "profiles", PROFILE_NAME);
  mkdirSync(profileDir, { recursive: true });
  for (const entry of entries) {
    const source = join(workspace, ...entry.split("/"));
    if (!existsSync(source)) continue;
    const target = join(profileDir, ...entry.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  // 种子 profile 的 bundles 由工具合并（官方 + app 自定义），与 dev 项目一致。
  writeFileSync(
    join(profileDir, "package.json"),
    `${JSON.stringify(
      {
        ...JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")),
        dsh: {
          ...manifest.dsh,
          profile: { ...manifest.dsh?.profile, bundles: mergedProfileBundles(manifest) },
        },
      },
      undefined,
      2,
    )}\n`,
  );
  // 闭包已由 pnpm 拍平（hoisted 布局：每个包一个顶层真实目录、无虚拟
  // 存储、无外部链接），原样复制进种子。
  cpSync(join(deployRoot, "node_modules"), join(profileDir, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  // 工作区包（@morlay/*）的 exports 指向 src（dev 友好），打包闭包没有
  // tsx 加载器——把闭包内这些包的 exports 切到 publishConfig 的 dist 产物。
  switchToPublishedExports(join(profileDir, "node_modules"));
  // 桌面宿主把 preset roots 钉在 dsh 包内的挂载点：包自声明（dsh.configTrees）与
  // app 显式声明的 preset 目录都必须物化到那里才会进入桌面 roster。
  materializeAgentPresets(
    profileDir,
    discoverPresetMounts(manifest, join(profileDir, "node_modules"), desktopAgentPresets(manifest)),
  );
  writeFileSync(join(profileDir, SEED_HASH_NAME), fingerprint);
  console.log(`desktop seed: wrote ${seedOutputRoot} (${fingerprint.slice(0, 12)})`);
}

/**
 * Rewrite `@morlay/*` package exports to their published dist form. The
 * flattened closure has every package at the top level; a package that only
 * lives in the virtual store is rewritten in place.
 */
function switchToPublishedExports(modulesDir: string): void {
  for (const [name, dir] of closurePackageDirs(modulesDir)) {
    if (!name.startsWith("@morlay/")) continue;
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      publishConfig?: { exports?: Record<string, string> };
    };
    const published = manifest.publishConfig?.exports;
    if (published === undefined) continue;
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, exports: published }, undefined, 2)}\n`,
    );
  }
}
