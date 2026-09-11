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
 * The app's manifest and the root lockfile are never rewritten: `pnpm deploy`
 * runs against the workspace as declared, and the official `@deepseek-ai/*`
 * surface (dsh, the bundled desktop host, the peer whitelist, and everything
 * they reach) is located by node resolution and copied into the deployed
 * closure afterwards. The closure is then flattened with pnpm's
 * `nodeLinker: hoisted` — a traditional node_modules layout with every package
 * at the top level, no virtual store, no external links — so the seed is fully
 * self-contained.
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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SEED_HASH_NAME } from "../seed.ts";

/** 目标 workspace 里承载本地源码包副本的目录。 */
const LOCAL_MEMBERS_DIR = "local";
import { materializeAgentPresets } from "./agent-presets.ts";
import {
  closurePackageDirs,
  materializeOfficialClosure,
  missingOfficialPackages,
  type OfficialResolutionInput,
} from "./official-deps.ts";
import {
  PROFILE_NAME,
  buildRoot,
  desktopAgentPresets,
  dshVersion as readDshVersion,
  findWorkspaceRoot,
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
 * Export the workspace production closure into the deploy staging directory.
 * The workspace manifest and the root lockfile are read, never written: the
 * deploy runs against the app as declared, and the official packages are
 * materialized into the deployed closure afterwards (`materializeOfficialClosure`),
 * located by node resolution instead of a rewritten dependency list. The
 * closure is then flattened: `nodeLinker: hoisted` reinstalls it as a
 * traditional node_modules layout (every package at the top level, no virtual
 * store, no external links).
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
  // 拍平：deploy 产物是 pnpm isolated 布局（.pnpm 虚拟存储 + 链接）。目标目录
  // **没有自己的 `pnpm-workspace.yaml`**，直接 install 会向上找到仓库根的
  // workspace，把依赖装进根、目标里什么都不生成——所以先写一个独立的空
  // workspace（`packages: []`）让目标自成一界，再用 `nodeLinker: hoisted`
  // 在目标内重排成传统 node_modules：每个包一个顶层真实目录、无虚拟存储、
  // 无外部链接，种子完全自包含。
  stageLocalWorkspace(destination, input);
  // deploy 的 isolated 布局（.pnpm + 链接）会被下面的安装整体重排；先删掉它，
  // 否则 pnpm 认为 node_modules 已是最新，不会按 nodeLinker 重建。
  rmSync(join(destination, "node_modules"), { recursive: true, force: true });
  await runPnpm(["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts"], destination);
  // 官方闭包：deploy 只带 app 声明的依赖，官方包（dsh、自带 host、peer
  // 白名单及其依赖树）由工具按包解析补进闭包顶层；已装的（app 自己的依赖
  // 树）优先，冲突时保留 pnpm 的解析结果。
  const copied = materializeOfficialClosure(modulesDir, input);
  console.log(`desktop seed: materialized ${String(copied.length)} official packages`);
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

/**
 * 目标目录自成一个 workspace：闭包里的**本地源码包**（workspace: 依赖解析到的
 * 仓库内目录）先复制成它的成员，于是那些包自带的 `workspace:` 依赖在目标内照样
 * 解析，不需要改任何源码清单，也不需要为它们去 registry 解析。根清单的本地依赖
 * 一并改写成 `workspace:^`（deploy 把它落成了绝对 `file://` 路径）。
 */
/** 根清单出发的本地包闭包：`workspace:` 依赖（含 peer）递归展开。 */
function localMemberClosure(input: OfficialResolutionInput): Map<string, string> {
  const local = localPackageDirs(input.workspaceRoot);
  const manifest = JSON.parse(readFileSync(join(input.workspace, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const members = new Map<string, string>();
  const queue = Object.keys(manifest.dependencies ?? {});
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || members.has(name)) continue;
    const dir = local.get(name);
    if (dir === undefined) continue; // registry 包：不在 workspace 内。
    members.set(name, dir);
    const member = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, spec] of Object.entries(member[field] ?? {})) {
        if (spec.startsWith("workspace:")) queue.push(dep);
      }
    }
  }
  return members;
}

function stageLocalWorkspace(destination: string, input: OfficialResolutionInput): void {
  const members = localMemberClosure(input);
  const membersRoot = join(destination, LOCAL_MEMBERS_DIR);
  rmSync(membersRoot, { recursive: true, force: true });
  for (const [name, dir] of members) {
    cpSync(dir, join(membersRoot, name.replace("/", "__")), {
      recursive: true,
      dereference: true,
      filter: (source) => !relative(dir, source).split(/[\\/]/u).includes("node_modules"),
    });
  }
  const manifestPath = join(destination, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = manifest.dependencies ?? {};
  for (const name of Object.keys(dependencies)) {
    if (members.has(name)) dependencies[name] = "workspace:^";
  }
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, undefined, 2)}\n`);
  writeFileSync(
    join(destination, "pnpm-workspace.yaml"),
    `packages:\n  - "${LOCAL_MEMBERS_DIR}/*"\nnodeLinker: hoisted\nminimumReleaseAge: 0\n`,
  );
  console.log(`desktop seed: staged ${String(members.size)} local workspace members`);
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
  for (const name of closurePackageDirs(input.closureModulesDir).keys()) {
    if (!local.has(name)) continue;
    hash.update(`${name}\0`);
    hashPath(hash, input.closureModulesDir, name);
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
  // 本地 workspace 成员副本：node_modules 里指向它们的符号链接是相对的
  // （`../../local/<name>`），必须一起进种子，否则链接全部断掉。
  cpSync(join(deployRoot, LOCAL_MEMBERS_DIR), join(profileDir, LOCAL_MEMBERS_DIR), {
    recursive: true,
  });
  // 工作区包（@morlay/*）的 exports 指向 src（dev 友好），打包闭包没有
  // tsx 加载器——把闭包内这些包的 exports 切到 publishConfig 的 dist 产物。
  switchToPublishedExports(join(profileDir, "node_modules"));
  // 桌面宿主把 preset roots 钉在 dsh 包内的挂载点，app 声明的 preset 目录
  // 必须物化到那里才会进入桌面 roster。
  materializeAgentPresets(profileDir, desktopAgentPresets(manifest));
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
