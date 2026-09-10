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
 * resolved dependency graph), and the closure content of every local source
 * package — `workspace:^` dependencies resolve to the workspace tree
 * (`@morlay/*`, vendored `@deepseek-ai/*`), so their sources can change while
 * every version string stays the same.
 *
 * The official `@deepseek-ai/*` dependency surface is maintained by the tool:
 * the official packages are injected into the workspace manifest before
 * deploy (and removed afterwards), so the deploy closure carries the
 * complete official tree (dsh, dsh-base, dsh-web-app, the peer packages).
 * The closure is then flattened with pnpm's `nodeLinker: hoisted` — a
 * traditional node_modules layout with every package at the top level, no
 * virtual store, no external links — so the seed is fully self-contained.
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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OFFICIAL_RUNTIME_PACKAGES } from "../official.ts";
import { SEED_HASH_NAME } from "../seed.ts";
import {
  PROFILE_NAME,
  buildRoot,
  findWorkspaceRoot,
  mergedProfileBundles,
  resolveWorkspace,
  workspaceManifest,
} from "./workspace.ts";

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
 * Export the workspace production closure into the deploy staging directory.
 * The official packages are injected into the workspace manifest and the
 * root lockfile is refreshed (`--lockfile-only`) so the deploy resolves them
 * from the vendor sources; both are restored afterwards. The deploy closure
 * is then flattened: `nodeLinker: hoisted` reinstalls it as a traditional
 * node_modules layout (every package at the top level, no virtual store, no
 * external links).
 */
async function deployClosure(workspace: string, name: string, destination: string): Promise<void> {
  const root = findWorkspaceRoot(workspace);
  const manifestPath = join(workspace, "package.json");
  const lockfilePath = join(root, "pnpm-lock.yaml");
  const originalManifest = readFileSync(manifestPath, "utf8");
  const originalLockfile = readFileSync(lockfilePath, "utf8");
  const manifest = JSON.parse(originalManifest) as { dependencies?: Record<string, string> };
  const dependencies = { ...manifest.dependencies };
  for (const packageName of OFFICIAL_RUNTIME_PACKAGES) dependencies[packageName] = "workspace:^";
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, undefined, 2)}\n`);
  try {
    await runPnpm(["install", "--lockfile-only"], root);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const args = root !== resolve(workspace) ? ["--filter", name] : [];
    await runPnpm([...args, "deploy", "--prod", "--ignore-scripts", destination], root);
    if (!existsSync(join(destination, "node_modules"))) {
      throw new Error(
        `desktop seed: pnpm deploy did not produce ${join(destination, "node_modules")}`,
      );
    }
    // 拍平：deploy 产物是 pnpm isolated 布局（.pnpm 虚拟存储 + 链接），
    // 目标内以 hoisted 布局重装成传统 node_modules——每个包一个顶层真实
    // 目录、无虚拟存储、无外部链接，种子完全自包含。
    const workspaceFile = join(destination, "pnpm-workspace.yaml");
    if (existsSync(workspaceFile)) {
      const raw = readFileSync(workspaceFile, "utf8");
      let content = raw.replaceAll(": set this to true or false", ": true");
      if (!content.includes("minimumReleaseAge"))
        content = `${content.trimEnd()}\nminimumReleaseAge: 0\n`;
      if (!content.includes("nodeLinker")) content = `${content.trimEnd()}\nnodeLinker: hoisted\n`;
      writeFileSync(workspaceFile, content);
    }
    await runPnpm(["install", "--no-frozen-lockfile", "--ignore-scripts"], destination);
  } finally {
    writeFileSync(manifestPath, originalManifest);
    writeFileSync(lockfilePath, originalLockfile);
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

/** Top-level package names of a flattened (hoisted) closure. */
function closurePackageNames(modulesDir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || TREE_SKIP_DIRS.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(join(modulesDir, entry.name)).sort()) {
        if (!scoped.startsWith(".")) names.push(`${entry.name}/${scoped}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names.sort();
}

/**
 * Seed fingerprint: whitelisted workspace content, the root lockfile (the
 * resolved dependency graph), and the closure content of every local source
 * package — `workspace:^` dependencies keep their version while their content
 * changes, so the closure itself is the only reliable signal.
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
  hash.update("local-closure\0");
  const local = localPackageDirs(input.workspaceRoot);
  for (const name of closurePackageNames(input.closureModulesDir)) {
    if (!local.has(name)) continue;
    hash.update(`${name}\0`);
    hashPath(hash, input.closureModulesDir, name);
  }
  return hash.digest("hex");
}

/** Options for the `prepare:seed` command. */
export interface PrepareSeedOptions {
  readonly workspace?: string;
}

export async function runPrepareSeed(options: PrepareSeedOptions): Promise<void> {
  const workspace = resolve(options.workspace ?? resolveWorkspace());
  const manifest = workspaceManifest(workspace);
  const buildRootDir = buildRoot(workspace);
  const seedOutputRoot = join(buildRootDir, "seed");
  const deployRoot = join(buildRootDir, "deploy");
  const entries = seedEntries(workspace, manifest);
  console.log(`desktop seed: workspace ${workspace} (${manifest.name})`);
  console.log(`desktop seed: whitelist ${entries.join(", ")}`);

  await deployClosure(workspace, manifest.name, deployRoot);
  // 指纹覆盖闭包内容：workspace:^ 依赖（morlay 包 / vendor 源码）版本号不变
  // 也可能变化，必须对 deploy 产物本身取指纹。
  const fingerprint = seedFingerprint({
    workspace,
    workspaceRoot: findWorkspaceRoot(workspace),
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
  writeFileSync(join(profileDir, SEED_HASH_NAME), fingerprint);
  console.log(`desktop seed: wrote ${seedOutputRoot} (${fingerprint.slice(0, 12)})`);
}

/**
 * Rewrite `@morlay/*` package exports to their published dist form. The
 * flattened closure has every package at the top level.
 */
function switchToPublishedExports(modulesDir: string): void {
  const scoped = join(modulesDir, "@morlay");
  if (!existsSync(scoped)) return;
  for (const entry of readdirSync(scoped, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(scoped, entry.name, "package.json");
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
