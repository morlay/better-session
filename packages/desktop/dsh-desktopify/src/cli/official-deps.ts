import type { Dirent } from "node:fs";
import { access, cp, glob, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_RUNTIME_PACKAGES } from "../official.ts";

export const DSH_PACKAGE = "@deepseek-ai/dsh";

export const DESKTOP_HOST_PACKAGE = "@deepseek-ai/dsh-desktop-host";

const TOOL_PACKAGE = "@morlay/dsh-desktopify";

const DESKTOP_HOST_EXPORT = `${TOOL_PACKAGE}/desktop-host`;

export interface OfficialPackage {
  readonly dir: string;
  readonly version: string;
}

export interface OfficialResolutionInput {
  readonly workspace: string;

  readonly workspaceRoot: string;

  readonly toolRoot: string;

  readonly dshVersion?: string;

  readonly closureModulesDir?: string;
}

interface PackageManifest {
  readonly version?: unknown;
  readonly files?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(dir: string): Promise<PackageManifest> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return {};
  }
}

export function officialSearchDirs(input: OfficialResolutionInput): string[] {
  return [
    ...new Set([
      join(input.workspace, "node_modules"),
      join(input.workspaceRoot, "node_modules", ".pnpm", "node_modules"),
      ...(input.closureModulesDir === undefined ? [] : [input.closureModulesDir]),
      join(input.toolRoot, "node_modules"),
      resolve(input.toolRoot, "..", ".."),
      resolve(input.toolRoot, "..", "..", "node_modules", ".pnpm", "node_modules"),
    ]),
  ];
}

export async function resolveOfficialPackage(
  packageName: string,
  input: OfficialResolutionInput,
): Promise<OfficialPackage | undefined> {
  for (const modulesDir of officialSearchDirs(input)) {
    const dir = join(modulesDir, ...packageName.split("/"));
    const manifest = await readManifest(dir);
    if (typeof manifest.version === "string" && manifest.version !== "") {
      return { dir: await realpath(dir), version: manifest.version };
    }
  }
  return undefined;
}

function desktopHostDir(): string | undefined {
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve(DESKTOP_HOST_EXPORT));
  } catch {
    return undefined;
  }

  return dirname(dirname(entry));
}

/**
 * The tool's own host payload — never the workspace or vendor copy of
 * `@deepseek-ai/dsh-desktop-host`.
 *
 * `import.meta.resolve` on the tool's own subpath export is a package self-reference, so only the
 * tool's `dist/desktop-host` can satisfy it; comparing against the tool's manifest root turns that
 * into a checked invariant, and a resolution from a `node_modules` tree fails here instead of
 * silently booting a payload this tool does not own.
 * @returns The payload directory and its manifest version, or `undefined` before the tool build.
 */
export async function desktopHost(): Promise<OfficialPackage | undefined> {
  const dir = desktopHostDir();
  if (dir === undefined) return undefined;
  const toolRoot = dirname(fileURLToPath(import.meta.resolve(`${TOOL_PACKAGE}/package.json`)));
  if (resolve(dir) !== join(toolRoot, "dist", "desktop-host")) {
    throw new Error(
      `dsh-desktopify: ${DESKTOP_HOST_PACKAGE} resolved outside the tool's own payload (${dir})`,
    );
  }
  const manifest = await readManifest(dir);
  return typeof manifest.version === "string" && manifest.version !== ""
    ? { dir, version: manifest.version }
    : undefined;
}

/**
 * Install the tool's host payload into a closure, replacing whatever payload is already there: a
 * deployment must boot this tool's composition, so a copy a previous run, the workspace, or the
 * vendor tree left behind may never satisfy the closure.
 * @param modulesDir - Closure `node_modules` directory.
 * @returns The installed payload directory.
 */
export async function materializeDesktopHost(modulesDir: string): Promise<string> {
  const host = await desktopHost();
  if (host === undefined) {
    throw new Error(
      `dsh-desktopify: bundled ${DESKTOP_HOST_PACKAGE} is missing; run the tool build (pnpm build)`,
    );
  }
  const target = join(modulesDir, ...DESKTOP_HOST_PACKAGE.split("/"));
  // Removing first also replaces a symlink into another tree with the owned copy.
  await rm(target, { recursive: true, force: true });
  await copyPackageTree(host.dir, target);
  return target;
}

export async function toolModulesDir(input: OfficialResolutionInput): Promise<string | undefined> {
  for (const modulesDir of [
    resolve(input.toolRoot, "..", "..", "node_modules", ".pnpm", "node_modules"),
    resolve(input.toolRoot, "..", ".."),
    join(input.toolRoot, "node_modules"),
  ]) {
    if (await pathExists(join(modulesDir, "@deepseek-ai"))) return modulesDir;
  }
  return undefined;
}

async function resolveDependencyDir(
  packageName: string,
  fromDir: string,
  input: OfficialResolutionInput,
): Promise<string | undefined> {
  for (const base of createRequire(join(fromDir, "package.json")).resolve.paths(packageName) ??
    []) {
    const dir = join(base, ...packageName.split("/"));
    if (await pathExists(join(dir, "package.json"))) return await realpath(dir);
  }
  for (const modulesDir of officialSearchDirs(input)) {
    const dir = join(modulesDir, ...packageName.split("/"));
    if (await pathExists(join(dir, "package.json"))) return await realpath(dir);
  }
  return undefined;
}

interface ManifestDependency {
  readonly name: string;
  readonly field: "dependencies" | "optionalDependencies" | "peerDependencies";
}

function manifestDependencies(manifest: PackageManifest): ManifestDependency[] {
  const found: ManifestDependency[] = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) found.push({ name, field });
  }
  return found;
}

export async function officialClosure(
  input: OfficialResolutionInput,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const pending: string[] = [];
  const add = (name: string, dir: string): void => {
    if (found.has(name)) return;
    found.set(name, dir);
    pending.push(name);
  };
  for (const name of OFFICIAL_RUNTIME_PACKAGES) {
    if (name === DESKTOP_HOST_PACKAGE) {
      const host = await desktopHost();
      if (host === undefined) {
        throw new Error(
          `dsh-desktopify: bundled ${DESKTOP_HOST_PACKAGE} is missing; run the tool build (pnpm build)`,
        );
      }
      add(name, host.dir);
      continue;
    }
    const resolved = await resolveOfficialPackage(name, input);
    if (resolved === undefined) {
      throw new Error(
        `dsh-desktopify: cannot resolve official package ${name}; ` +
          "install it in the workspace or run from the tool's own install",
      );
    }
    add(name, resolved.dir);
  }
  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index] as string;
    const dir = found.get(name) as string;
    for (const dependency of manifestDependencies(await readManifest(dir))) {
      if (found.has(dependency.name)) continue;
      const dependencyDir = await resolveDependencyDir(dependency.name, dir, input);
      if (dependencyDir === undefined) {
        if (dependency.field === "dependencies" && dependency.name.startsWith("@deepseek-ai/")) {
          throw new Error(
            `dsh-desktopify: official package ${name} needs ${dependency.name}, which cannot be resolved`,
          );
        }
        continue;
      }
      add(dependency.name, dependencyDir);
    }
  }
  return found;
}

function isPackagePayload(path: string, root: string): boolean {
  const relativePath = path.slice(root.length).replace(/^[\\/]+/u, "");
  return relativePath === "" || !relativePath.split(/[\\/]/u).includes("node_modules");
}

async function expandPackageFiles(dir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const match of glob(pattern, { cwd: dir })) matches.push(match);
  if (matches.length > 0) return matches;

  return (await pathExists(join(dir, pattern))) ? [pattern] : [];
}

async function packagePayload(dir: string): Promise<string[] | undefined> {
  const files = (await readManifest(dir)).files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const included = new Set<string>(["package.json"]);
  const excluded = new Set<string>();
  for (const value of files) {
    if (typeof value !== "string" || value === "") continue;
    const negated = value.startsWith("!");
    for (const match of await expandPackageFiles(dir, negated ? value.slice(1) : value)) {
      if (negated) excluded.add(match);
      else included.add(match);
    }
  }
  return [...included].filter((entry) => !excluded.has(entry)).sort();
}

function isInstalledPackage(dir: string): boolean {
  return dir.split(/[\\/]/u).includes("node_modules");
}

export async function copyPackageTree(source: string, target: string): Promise<void> {
  const payload = isInstalledPackage(source) ? undefined : await packagePayload(source);
  const copy = async (from: string, to: string): Promise<void> => {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, {
      recursive: true,
      dereference: true,
      filter: (entry) => isPackagePayload(entry, source),
    });
  };
  if (payload === undefined) {
    await copy(source, target);
    return;
  }
  for (const entry of payload) {
    const from = join(source, ...entry.split("/"));
    if (await pathExists(from)) await copy(from, join(target, ...entry.split("/")));
  }
}

export async function materializeOfficialClosure(
  modulesDir: string,
  input: OfficialResolutionInput,
): Promise<string[]> {
  const copied: string[] = [DESKTOP_HOST_PACKAGE];
  await materializeDesktopHost(modulesDir);
  for (const [name, dir] of await officialClosure({ ...input, closureModulesDir: modulesDir })) {
    if (name === DESKTOP_HOST_PACKAGE) continue;
    const target = join(modulesDir, ...name.split("/"));
    if (await pathExists(target)) continue;
    await copyPackageTree(dir, target);
    copied.push(name);
  }
  return copied;
}

export async function closurePackageDirs(modulesDir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const add = async (name: string, dir: string): Promise<void> => {
    if (found.has(name)) return;
    try {
      found.set(name, await realpath(dir));
    } catch {
      found.set(name, dir);
    }
  };
  const collect = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        let scoped: Dirent[];
        try {
          scoped = await readdir(path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of scoped) {
          if (!child.name.startsWith("."))
            await add(`${entry.name}/${child.name}`, join(path, child.name));
        }
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) await add(entry.name, path);
    }
  };
  await collect(modulesDir);
  const virtual = join(modulesDir, ".pnpm");
  if (await pathExists(virtual)) {
    for (const entry of await readdir(virtual, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const layer = join(virtual, entry.name, "node_modules");
      if (await pathExists(layer)) await collect(layer);
    }
  }
  return found;
}

export async function missingOfficialPackages(modulesDir: string): Promise<Map<string, string[]>> {
  const dirs = await closurePackageDirs(modulesDir);
  const present = new Set(dirs.keys());
  const missing = new Map<string, string[]>();
  for (const [name, dir] of dirs) {
    if (!name.startsWith("@deepseek-ai/")) continue;
    const manifest = await readManifest(dir);
    for (const field of ["dependencies", "peerDependencies"] as const) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (!dependency.startsWith("@deepseek-ai/") || present.has(dependency)) continue;
        if (
          field === "peerDependencies" &&
          manifest.peerDependenciesMeta?.[dependency]?.optional === true
        )
          continue;
        const requiredBy = missing.get(dependency) ?? [];
        if (!requiredBy.includes(name)) requiredBy.push(name);
        missing.set(dependency, requiredBy);
      }
    }
  }
  return missing;
}

export async function officialDependencySpecs(
  input: OfficialResolutionInput,
): Promise<Record<string, string>> {
  const specs: Record<string, string> = {};
  const missing: string[] = [];

  const localSources = input.dshVersion?.startsWith("workspace:") === true;
  for (const packageName of OFFICIAL_RUNTIME_PACKAGES) {
    if (packageName === DSH_PACKAGE && input.dshVersion !== undefined && !localSources) {
      specs[packageName] = input.dshVersion;
      continue;
    }
    if (packageName === DESKTOP_HOST_PACKAGE) {
      const host = await desktopHost();
      if (host === undefined) {
        missing.push(packageName);
        continue;
      }
      specs[packageName] = `link:${host.dir}`;
      continue;
    }
    const resolved = await resolveOfficialPackage(packageName, input);
    if (resolved === undefined) {
      missing.push(packageName);
      continue;
    }
    specs[packageName] = localSources ? `file:${resolved.dir}` : `^${resolved.version}`;
  }
  if (missing.length > 0) {
    throw new Error(
      `dsh-desktopify: cannot resolve official packages ${missing.join(", ")}; ` +
        "install them in the workspace or run from the tool's own install",
    );
  }
  return specs;
}

export async function officialDeploySpecs(
  input: OfficialResolutionInput,
  fallbackVersion?: string,
): Promise<Record<string, string>> {
  const specs: Record<string, string> = {};

  if (input.dshVersion?.startsWith("workspace:") === true) return specs;
  for (const packageName of OFFICIAL_RUNTIME_PACKAGES) {
    if (packageName === DSH_PACKAGE && input.dshVersion !== undefined) {
      specs[packageName] = input.dshVersion;
      continue;
    }
    if (packageName === DESKTOP_HOST_PACKAGE) continue;
    const resolved = await resolveOfficialPackage(packageName, input);
    if (resolved === undefined) {
      const harnessVersioned = packageName.startsWith("@deepseek-ai/dsh");
      if (harnessVersioned && fallbackVersion !== undefined && fallbackVersion !== "")
        specs[packageName] = fallbackVersion;
      continue;
    }
    if (!isInstalledPackage(resolved.dir)) continue;
    specs[packageName] = `^${resolved.version}`;
  }
  return specs;
}

export function hasTsx(workspace: string, workspaceRoot: string): boolean {
  for (const dir of [workspace, workspaceRoot]) {
    try {
      createRequire(join(dir, "package.json")).resolve("tsx/esm");
      return true;
    } catch {}
  }
  return false;
}
