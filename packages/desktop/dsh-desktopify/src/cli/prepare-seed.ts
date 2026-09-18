import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { OFFICIAL_PROFILE_BUNDLES } from "../official.ts";
import {
  PROFILE_RUNTIME_REPORT_NAME,
  PROFILE_VENDOR_DIR_NAME,
  PROFILE_WORKSPACE_NAME,
} from "../profile-project.ts";
import { SEED_HASH_NAME, SEED_RUNTIME_DIR_NAME } from "../seed.ts";
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
  cleanDeployedSpec,
  desktopAgentPresets,
  dshVersion as readDshVersion,
  findWorkspaceRoot,
  mergedDeploySettings,
  mergedProfileBundles,
  resolveWorkspace,
  topLevelYamlBlock,
  workspaceManifest,
  type WorkspaceManifest,
} from "./workspace.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

async function inheritDeploySettings(root: string, destination: string): Promise<void> {
  const sourcePath = join(root, "pnpm-workspace.yaml");
  const targetPath = join(destination, "pnpm-workspace.yaml");
  if (!(await pathExists(sourcePath)) || !(await pathExists(targetPath))) return;
  const target = await readFile(targetPath, "utf8");
  const merged = mergedDeploySettings(await readFile(sourcePath, "utf8"), target);
  if (merged !== target) await writeFile(targetPath, merged);
}

async function installOfficialSurface(
  destination: string,
  input: OfficialResolutionInput,
): Promise<void> {
  const pin = (await resolveOfficialPackage(DSH_PACKAGE, input))?.version ?? input.dshVersion;
  const specs = await officialDeploySpecs(
    input,
    pin === undefined || pin.startsWith("workspace:") ? undefined : pin,
  );
  const names = Object.keys(specs);
  if (names.length === 0) return;
  const manifestPath = join(destination, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = new Map(
    Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => [
      name,
      cleanDeployedSpec(spec),
    ]),
  );
  for (const [name, spec] of Object.entries(specs)) dependencies.set(name, spec);
  await writeFile(
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

async function deployClosure(
  workspace: string,
  name: string,
  destination: string,
  input: OfficialResolutionInput,
): Promise<void> {
  const root = await findWorkspaceRoot(workspace);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const args = root !== resolve(workspace) ? ["--filter", name] : [];
  await runPnpm([...args, "deploy", "--prod", "--ignore-scripts", destination], root);
  const modulesDir = join(destination, "node_modules");
  if (!(await pathExists(modulesDir))) {
    throw new Error(`desktop seed: pnpm deploy did not produce ${modulesDir}`);
  }

  await inheritDeploySettings(root, destination);
  await installOfficialSurface(destination, input);

  await linkClosureTopLevel(modulesDir);
  const copied = await materializeOfficialClosure(modulesDir, input);
  console.log(`desktop seed: copied ${String(copied.length)} official source packages`);

  const missing = await missingOfficialPackages(modulesDir);
  if (missing.size > 0) {
    const detail = [...missing]
      .map(([packageName, requiredBy]) => `${packageName} (required by ${requiredBy.join(", ")})`)
      .join("; ");
    throw new Error(
      `desktop seed: deployed closure is missing official packages: ${detail}; ` +
        "regenerate the injected surface with `pnpm --filter @morlay/dsh-desktopify run gen:official-packages`",
    );
  }
}

async function linkClosureTopLevel(modulesDir: string): Promise<void> {
  const store = join(modulesDir, ".pnpm");
  if (!(await pathExists(store))) return;
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inner = join(store, entry.name, "node_modules");
    if (!(await pathExists(inner))) continue;
    for (const [name, dir] of await closurePackageDirs(inner)) {
      const link = join(modulesDir, ...name.split("/"));
      if (await pathExists(link)) continue;
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), dir), link, "dir");
    }
  }
}

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

const TREE_SKIP_DIRS = new Set([
  ".bin",
  ".cache",
  ".git",
  ".dsh-store",
  ".pnpm-store",
  ".turbo",
  "node_modules",
]);

const LOCAL_PACKAGE_SCAN_DEPTH = 6;

async function hashPath(hash: Hash, root: string, relativePath: string): Promise<void> {
  const path = join(root, ...relativePath.split("/"));
  if (!(await pathExists(path))) return;
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) {
      if (TREE_SKIP_DIRS.has(entry)) continue;
      await hashPath(hash, root, `${relativePath}/${entry}`);
    }
    return;
  }
  if (!info.isFile()) return;
  hash.update(relativePath);
  hash.update("\0");
  hash.update(await readFile(path));
  hash.update("\0");
}

async function packageName(manifestPath: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

async function localPackageDirs(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > LOCAL_PACKAGE_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || TREE_SKIP_DIRS.has(entry.name))
        continue;
      const child = join(dir, entry.name);
      const manifestPath = join(child, "package.json");
      if (await pathExists(manifestPath)) {
        const name = await packageName(manifestPath);
        if (name !== undefined && !found.has(name)) found.set(name, child);
      }
      await visit(child, depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

async function packageEntries(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      found.push(path);
      if (entry.isDirectory()) await visit(join(current, entry.name), path);
    }
  };
  await visit(dir, "");
  return found.sort();
}

export async function seedFingerprint(input: {
  readonly workspace: string;
  readonly workspaceRoot: string;
  readonly entries: readonly string[];
  readonly closureModulesDir: string;
  readonly seedRoot: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("workspace\0");
  for (const entry of input.entries) await hashPath(hash, input.workspace, entry);
  hash.update("lockfile\0");
  const lockfile = join(input.workspaceRoot, "pnpm-lock.yaml");
  if (await pathExists(lockfile)) {
    hash.update(await readFile(lockfile));
    hash.update("\0");
  }

  const closure = await closurePackageDirs(input.closureModulesDir);
  hash.update("closure\0");
  for (const name of closure.keys()) {
    hash.update(`${name}\0`);
  }
  hash.update("local-closure\0");
  const local = await localPackageDirs(input.workspaceRoot);
  for (const name of closure.keys()) {
    if (!local.has(name)) continue;
    hash.update(`${name}\0`);
    await hashPath(hash, input.closureModulesDir, name);
  }

  hash.update("installed-closure\0");
  for (const [name, dir] of closure) {
    if (local.has(name)) continue;
    hash.update(`${name}\0`);
    for (const entry of await packageEntries(dir)) hash.update(`${entry}\0`);
  }
  await hashSeedLayout(hash, input.seedRoot);
  return hash.digest("hex");
}

/**
 * Hash the seed's own layout: generated manifests and settings decide the planted profile,
 * while closure contents are already covered by the closure inputs above. `vendor/` is only
 * enumerated because its payload is a closure copy.
 */
async function hashSeedLayout(hash: Hash, seedRoot: string): Promise<void> {
  hash.update("seed-layout\0");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name === "node_modules" || entry.name === SEED_HASH_NAME) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name === PROFILE_VENDOR_DIR_NAME) {
        await hashVendorPackages(hash, join(directory, entry.name), path);
        continue;
      }
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(child, path);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(path);
      hash.update("\0");
      hash.update(await readFile(child));
      hash.update("\0");
    }
  };
  await visit(seedRoot, "");
}

/** Enumerate the `file:` sources by package path; their payload is a closure copy already hashed. */
async function hashVendorPackages(hash: Hash, directory: string, prefix: string): Promise<void> {
  if (await pathExists(join(directory, "package.json"))) {
    hash.update(`${prefix}\0`);
    return;
  }
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : 1,
  )) {
    if (!entry.isDirectory()) continue;
    const child = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    await hashVendorPackages(hash, join(directory, entry.name), child);
  }
}

export interface PrepareSeedOptions {
  readonly workspace?: string;
}

export async function runPrepareSeed(options: PrepareSeedOptions): Promise<void> {
  const workspace = resolve(options.workspace ?? resolveWorkspace());
  const manifest = await workspaceManifest(workspace);
  const workspaceRoot = await findWorkspaceRoot(workspace);
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

  await rm(seedOutputRoot, { recursive: true, force: true });
  const runtimeDir = join(seedOutputRoot, SEED_RUNTIME_DIR_NAME);
  const runtimeModulesDir = join(runtimeDir, "node_modules");
  const profileDir = join(seedOutputRoot, "profiles", PROFILE_NAME);
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  // 运行时载荷：deploy 闭包就是 host 的 dsh 安装（解析锚点）与前端静态资源的来源；
  // 它在产物里不可变，也不再被种进用户的 DSH_HOME。
  await cp(join(deployRoot, "package.json"), join(runtimeDir, "package.json"));
  await cp(join(deployRoot, "node_modules"), runtimeModulesDir, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await switchToPublishedExports(runtimeModulesDir);

  // profile 只持有 app 自带的（非官方 bundle）插件：官方包与 dsh 由 runtime 提供，
  // 这些包以 `file:` 指向随包 vendor 副本，由启动器用随包 pnpm 在用户 profile 里装出来。
  const localBundles = profileLocalBundles(manifest);
  await copyProfileEntries(workspace, profileDir, entries);
  await copyVendorSources(runtimeModulesDir, profileDir, localBundles);
  const runtimeLinks = await profileRuntimeLinks(runtimeDir, runtimeModulesDir, localBundles);
  await writeFile(
    join(profileDir, "package.json"),
    `${JSON.stringify(profileManifest(manifest, localBundles), undefined, 2)}\n`,
  );
  await writeFile(
    join(profileDir, PROFILE_WORKSPACE_NAME),
    profileWorkspace(await allowedBuilds(deployRoot)),
  );
  await writeFile(
    join(profileDir, PROFILE_RUNTIME_REPORT_NAME),
    `${JSON.stringify({ schemaVersion: 1, runtimePackages: runtimeLinks }, undefined, 2)}\n`,
  );

  await materializeAgentPresets(
    runtimeDir,
    await discoverPresetMounts(manifest, runtimeModulesDir, desktopAgentPresets(manifest)),
  );

  const fingerprint = await seedFingerprint({
    workspace,
    workspaceRoot,
    entries,
    closureModulesDir: runtimeModulesDir,
    seedRoot: seedOutputRoot,
  });
  await writeFile(join(profileDir, SEED_HASH_NAME), fingerprint);
  console.log(
    `desktop seed: wrote ${seedOutputRoot} (${fingerprint.slice(0, 12)}), ` +
      `profile bundles ${localBundles.join(", ") || "(none)"}`,
  );
}

/** Bundles the profile itself owns; shipped bundles come from the runtime installation instead. */
export function profileLocalBundles(manifest: WorkspaceManifest): string[] {
  return mergedProfileBundles(manifest).filter((name) => !OFFICIAL_PROFILE_BUNDLES.includes(name));
}

/** Generate the profile manifest: app identity plus its own bundles as `file:` dependencies. */
export function profileManifest(
  manifest: WorkspaceManifest,
  localBundles: readonly string[],
): Record<string, unknown> {
  return {
    name: manifest.name,
    private: true,
    version: manifest.version ?? "0.0.0",
    type: "module",
    dependencies: Object.fromEntries(
      localBundles.map((name) => [name, `file:./${PROFILE_VENDOR_DIR_NAME}/${name}`]),
    ),
    // profile 是安装产物：只保留 profile 层装配字段，app 的 dsh.version / desktop / dev
    // 属于打包输入，运行时不再从 profile 读它们。
    dsh: { profile: { ...manifest.dsh?.profile, bundles: mergedProfileBundles(manifest) } },
  };
}

/** Profile pnpm settings shared by the seed and every later package operation. */
export function profileWorkspace(allowBuilds: string): string {
  return `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n${allowBuilds}`;
}

/** Copy the app's whitelisted files into the profile; the manifest is generated, never copied. */
async function copyProfileEntries(
  workspace: string,
  profileDir: string,
  entries: readonly string[],
): Promise<void> {
  for (const entry of entries) {
    if (entry === "package.json") continue;
    const source = join(workspace, ...entry.split("/"));
    if (!(await pathExists(source))) continue;
    const target = join(profileDir, ...entry.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}

/** Copy each profile-owned bundle out of the closure as an installable `file:` source. */
async function copyVendorSources(
  runtimeModulesDir: string,
  profileDir: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const source = join(runtimeModulesDir, ...name.split("/"));
    if (!(await pathExists(source))) {
      throw new Error(
        `desktop seed: profile bundle ${name} is missing from the deployed closure (${source})`,
      );
    }
    const target = join(profileDir, PROFILE_VENDOR_DIR_NAME, ...name.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: true });
  }
}

/** Runtime packages the profile's own dependencies resolve through `overrides`, with runtime-relative paths.
 *
 * profile 自己的包来自工作区（`file:` 源），它们的依赖在 profile 里都无法解析：`workspace:` 协议没有工作区，
 * 普通范围则要回 registry（离线安装拿不到 metadata）。所以打包时把每个能在闭包里找到的依赖都定位到 runtime
 * 的副本，由壳写成 `link:` 覆盖——安装因此不需要 registry，profile 里这些包也与 runtime 共享同一份实例。
 * peer / optional 依赖找不到就跳过（profile 安装不装 peer：`autoInstallPeers: false`）；普通依赖找不到即打包
 * 失败：那不是"装不上"，而是 host 运行时也解析不到。
 */
export async function profileRuntimeLinks(
  runtimeRoot: string,
  runtimeModulesDir: string,
  names: readonly string[],
): Promise<{ name: string; path: string }[]> {
  const required = new Map<string, boolean>();
  for (const name of names) {
    const manifestPath = join(runtimeModulesDir, ...name.split("/"), "package.json");
    if (!(await pathExists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      required.set(dependency, true);
    }
    for (const section of [manifest.peerDependencies, manifest.optionalDependencies]) {
      for (const dependency of Object.keys(section ?? {})) {
        if (!required.has(dependency)) required.set(dependency, false);
      }
    }
  }
  if (required.size === 0) return [];

  const closure = await closurePackageDirs(runtimeModulesDir);
  const canonicalRoot = await realpath(runtimeRoot);
  const links: { name: string; path: string }[] = [];
  const missing: string[] = [];
  for (const dependency of [...required.keys()].sort()) {
    const dir = closure.get(dependency);
    if (dir !== undefined) {
      links.push({ name: dependency, path: relative(canonicalRoot, dir) });
      continue;
    }
    if (required.get(dependency) === true) missing.push(dependency);
  }
  if (missing.length > 0) {
    throw new Error(
      `desktop seed: the deployed closure is missing dependencies of the profile's own bundles: ` +
        `${missing.join(", ")}`,
    );
  }
  return links;
}

/** The workspace `allowBuilds` block pnpm wrote into the deploy project, carried into the profile. */
async function allowedBuilds(deployRoot: string): Promise<string> {
  const path = join(deployRoot, PROFILE_WORKSPACE_NAME);
  if (!(await pathExists(path))) return "";
  return topLevelYamlBlock(await readFile(path, "utf8"), "allowBuilds") ?? "";
}

async function switchToPublishedExports(modulesDir: string): Promise<void> {
  for (const [name, dir] of await closurePackageDirs(modulesDir)) {
    if (!name.startsWith("@morlay/")) continue;
    const manifestPath = join(dir, "package.json");
    if (!(await pathExists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      publishConfig?: { exports?: Record<string, string> };
    };
    const published = manifest.publishConfig?.exports;
    if (published === undefined) continue;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, exports: published }, undefined, 2)}\n`,
    );
  }
}
