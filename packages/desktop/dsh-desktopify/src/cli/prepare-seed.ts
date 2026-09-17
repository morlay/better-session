import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  cleanDeployedSpec,
  desktopAgentPresets,
  dshVersion as readDshVersion,
  findWorkspaceRoot,
  mergedDeploySettings,
  mergedProfileBundles,
  resolveWorkspace,
  workspaceManifest,
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
  return hash.digest("hex");
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

  const fingerprint = await seedFingerprint({
    workspace,
    workspaceRoot,
    entries,
    closureModulesDir: join(deployRoot, "node_modules"),
  });

  await rm(seedOutputRoot, { recursive: true, force: true });
  const profileDir = join(seedOutputRoot, "profiles", PROFILE_NAME);
  await mkdir(profileDir, { recursive: true });
  for (const entry of entries) {
    const source = join(workspace, ...entry.split("/"));
    if (!(await pathExists(source))) continue;
    const target = join(profileDir, ...entry.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }

  await writeFile(
    join(profileDir, "package.json"),
    `${JSON.stringify(
      {
        ...JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")),
        dsh: {
          ...manifest.dsh,
          profile: { ...manifest.dsh?.profile, bundles: mergedProfileBundles(manifest) },
        },
      },
      undefined,
      2,
    )}\n`,
  );

  await cp(join(deployRoot, "node_modules"), join(profileDir, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });

  await switchToPublishedExports(join(profileDir, "node_modules"));

  await materializeAgentPresets(
    profileDir,
    await discoverPresetMounts(
      manifest,
      join(profileDir, "node_modules"),
      desktopAgentPresets(manifest),
    ),
  );
  await writeFile(join(profileDir, SEED_HASH_NAME), fingerprint);
  console.log(`desktop seed: wrote ${seedOutputRoot} (${fingerprint.slice(0, 12)})`);
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
