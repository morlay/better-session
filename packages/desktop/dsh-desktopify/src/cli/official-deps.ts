/**
 * Official `@deepseek-ai/*` dependency resolution for one target workspace.
 *
 * The app declares only its own dependencies plus `dsh.version` (the
 * `@deepseek-ai/dsh` dependency spec it targets); the tool maintains the
 * official surface (`../official.ts`). Packages are located by node resolution
 * — the app workspace first, then the tool's own install — so nothing
 * hardcodes the `workspace:` protocol or a repository layout, and an app
 * outside this repository resolves the same way:
 *   - `@deepseek-ai/dsh` → the resolved package directory when the app targets
 *     local sources (`dsh.version: workspace:*`, whose version may be
 *     unpublished), else its concrete version spec;
 *   - `@deepseek-ai/dsh-desktop-host` → the tool's own bundled host artifact
 *     (upstream never publishes it);
 *   - every other official package → `file:<dir>` when it resolves to local
 *     sources, else `^<version>`.
 *
 * `officialClosure` walks the official dependency graph from those roots (the
 * dsh CLI, the bundled host, and the peer whitelist) and
 * `materializeOfficialClosure` copies it into an assembled closure, so the
 * packaged profile carries the complete official tree without ever rewriting
 * the target workspace's manifest or lockfile.
 *
 * `hasTsx` reports whether the workspace can load TypeScript sources directly;
 * the tool only injects `--import=tsx/esm` when it can.
 * @module @morlay/dsh-desktopify
 */

import {
  cpSync,
  type Dirent,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_RUNTIME_PACKAGES } from "../official.ts";

/** Installation anchor the upstream desktop host resolves profile bundles from. */
export const DSH_PACKAGE = "@deepseek-ai/dsh";

/** Private byte-pipe backend installed beside dsh; never published to a registry. */
export const DESKTOP_HOST_PACKAGE = "@deepseek-ai/dsh-desktop-host";

/** The tool package name, used to resolve its own exported host artifact. */
const TOOL_PACKAGE = "@morlay/dsh-desktopify";

/** Subpath export carrying the bundled desktop-host entry (`tsdown.config.ts`). */
const DESKTOP_HOST_EXPORT = `${TOOL_PACKAGE}/desktop-host`;

/** One resolved official package: its directory and installed version. */
export interface OfficialPackage {
  readonly dir: string;
  readonly version: string;
}

/** Resolution roots for one target workspace. */
export interface OfficialResolutionInput {
  /** App workspace directory. */
  readonly workspace: string;
  /** pnpm workspace root above the app workspace. */
  readonly workspaceRoot: string;
  /** The tool package root (source `src/cli` and built `dist/cli` are same depth). */
  readonly toolRoot: string;
  /** `dsh.version` declared by the app, when present. */
  readonly dshVersion?: string;
}

/** The subset of a package manifest the resolution walks. */
interface PackageManifest {
  readonly version?: unknown;
  readonly files?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

/** Read a package manifest, tolerating an unreadable or missing file. */
function readManifest(dir: string): PackageManifest {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return {};
  }
}

/**
 * `node_modules` roots searched for the official surface, in priority order:
 * the app's own install, its pnpm virtual store, the tool's install, and the
 * tool's surrounding install (the repository store in-tree, the app's
 * `node_modules` when the tool is installed as a dependency).
 */
export function officialSearchDirs(input: OfficialResolutionInput): string[] {
  return [
    ...new Set([
      join(input.workspace, "node_modules"),
      join(input.workspaceRoot, "node_modules", ".pnpm", "node_modules"),
      join(input.toolRoot, "node_modules"),
      resolve(input.toolRoot, "..", ".."),
      resolve(input.toolRoot, "..", "..", "node_modules", ".pnpm", "node_modules"),
    ]),
  ];
}

/** Resolve one official package from the workspace, then the tool. */
export function resolveOfficialPackage(
  packageName: string,
  input: OfficialResolutionInput,
): OfficialPackage | undefined {
  for (const modulesDir of officialSearchDirs(input)) {
    const dir = join(modulesDir, ...packageName.split("/"));
    const manifest = readManifest(dir);
    if (typeof manifest.version === "string" && manifest.version !== "") {
      return { dir: realpathSync(dir), version: manifest.version };
    }
  }
  return undefined;
}

/**
 * The tool's bundled desktop-host artifact. Upstream keeps
 * `@deepseek-ai/dsh-desktop-host` private (never published), so the tool ships
 * its built output itself and declares it as the `./desktop-host` subpath
 * export (`tsdown.config.ts`); resolving that export — instead of a hardcoded
 * `dist` path — keeps source and published layouts interchangeable.
 */
function desktopHostDir(): string | undefined {
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve(DESKTOP_HOST_EXPORT));
  } catch {
    return undefined; // Not built yet: the artifact is missing from `dist`.
  }
  // `<...>/dist/desktop-host/lib/index.js` → the package directory.
  return dirname(dirname(entry));
}

/** The bundled desktop host, or `undefined` when it has not been built. */
export function desktopHost(): OfficialPackage | undefined {
  const dir = desktopHostDir();
  if (dir === undefined) return undefined;
  const manifest = readManifest(dir);
  return typeof manifest.version === "string" && manifest.version !== ""
    ? { dir, version: manifest.version }
    : undefined;
}

/**
 * The tool's own `node_modules` root holding the official surface, used as a
 * dev fallback for an app that declares only `dsh.version` and has not
 * installed the official packages itself. Prefers the surrounding store (the
 * repository virtual store in-tree, the app store when installed as a
 * dependency) over the tool's direct dependencies.
 */
export function toolModulesDir(input: OfficialResolutionInput): string | undefined {
  for (const modulesDir of [
    resolve(input.toolRoot, "..", "..", "node_modules", ".pnpm", "node_modules"),
    resolve(input.toolRoot, "..", ".."),
    join(input.toolRoot, "node_modules"),
  ]) {
    if (existsSync(join(modulesDir, "@deepseek-ai"))) return modulesDir;
  }
  return undefined;
}

/** Locate one dependency of a package the way node would resolve it at runtime. */
function resolveDependencyDir(
  packageName: string,
  fromDir: string,
  input: OfficialResolutionInput,
): string | undefined {
  for (const base of createRequire(join(fromDir, "package.json")).resolve.paths(packageName) ??
    []) {
    const dir = join(base, ...packageName.split("/"));
    if (existsSync(join(dir, "package.json"))) return realpathSync(dir);
  }
  for (const modulesDir of officialSearchDirs(input)) {
    const dir = join(modulesDir, ...packageName.split("/"));
    if (existsSync(join(dir, "package.json"))) return realpathSync(dir);
  }
  return undefined;
}

/** One manifest dependency, with the field it was declared in. */
interface ManifestDependency {
  readonly name: string;
  readonly field: "dependencies" | "optionalDependencies" | "peerDependencies";
}

/** Every dependency a package declares, in walk order. */
function manifestDependencies(manifest: PackageManifest): ManifestDependency[] {
  const found: ManifestDependency[] = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) found.push({ name, field });
  }
  return found;
}

/**
 * The complete official dependency closure: the official roots
 * (`../official.ts`) plus everything they reach through `dependencies`,
 * `optionalDependencies`, and resolvable `peerDependencies`. Package name →
 * package directory. Throws when an official root or an official dependency
 * cannot be located; an unresolvable peer (tsx, electron, …) is provided by
 * the consumer and is skipped.
 */
export function officialClosure(input: OfficialResolutionInput): Map<string, string> {
  const found = new Map<string, string>();
  const pending: string[] = [];
  const add = (name: string, dir: string): void => {
    if (found.has(name)) return;
    found.set(name, dir);
    pending.push(name);
  };
  for (const name of OFFICIAL_RUNTIME_PACKAGES) {
    if (name === DESKTOP_HOST_PACKAGE) {
      const host = desktopHost();
      if (host === undefined) {
        throw new Error(
          `dsh-desktopify: bundled ${DESKTOP_HOST_PACKAGE} is missing; run the tool build (pnpm build)`,
        );
      }
      add(name, host.dir);
      continue;
    }
    const resolved = resolveOfficialPackage(name, input);
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
    for (const dependency of manifestDependencies(readManifest(dir))) {
      if (found.has(dependency.name)) continue;
      const dependencyDir = resolveDependencyDir(dependency.name, dir, input);
      if (dependencyDir === undefined) {
        // peer / optional 依赖由消费方或平台提供（tsx、electron、平台二进制）。
        if (dependency.field === "peerDependencies") continue;
        if (dependency.name.startsWith("@deepseek-ai/")) {
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

/** Paths inside a package directory that never enter an assembled closure. */
function isPackagePayload(path: string, root: string): boolean {
  const relativePath = path.slice(root.length).replace(/^[\\/]+/u, "");
  return relativePath === "" || !relativePath.split(/[\\/]/u).includes("node_modules");
}

/** Expand one `files` entry of a package manifest. */
function expandPackageFiles(dir: string, pattern: string): string[] {
  const matches = globSync(pattern, { cwd: dir });
  if (matches.length > 0) return matches;
  // 目录模式（`files: ["lib"]`）在部分 glob 实现下不产生匹配。
  return existsSync(join(dir, pattern)) ? [pattern] : [];
}

/**
 * The payload entries of a package directory: its manifest `files` whitelist
 * when declared (so a vendored source package ships its built output, not its
 * sources), the whole directory otherwise.
 */
function packagePayload(dir: string): string[] | undefined {
  const files = readManifest(dir).files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const included = new Set<string>(["package.json"]);
  const excluded = new Set<string>();
  for (const value of files) {
    if (typeof value !== "string" || value === "") continue;
    const negated = value.startsWith("!");
    for (const match of expandPackageFiles(dir, negated ? value.slice(1) : value)) {
      if (negated) excluded.add(match);
      else included.add(match);
    }
  }
  return [...included].filter((entry) => !excluded.has(entry)).sort();
}

/** Copy one package directory into the closure, honouring its `files` whitelist. */
function copyPackageTree(source: string, target: string): void {
  const payload = packagePayload(source);
  const copy = (from: string, to: string): void => {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: true,
      dereference: true,
      filter: (entry) => isPackagePayload(entry, source),
    });
  };
  if (payload === undefined) {
    copy(source, target);
    return;
  }
  for (const entry of payload) {
    const from = join(source, ...entry.split("/"));
    if (existsSync(from)) copy(from, join(target, ...entry.split("/")));
  }
}

/**
 * Copy the official closure into an assembled closure, keeping whatever pnpm
 * already installed there (the app's own dependency tree wins on conflicts).
 * Returns the copied package names.
 */
export function materializeOfficialClosure(
  modulesDir: string,
  input: OfficialResolutionInput,
): string[] {
  const copied: string[] = [];
  for (const [name, dir] of officialClosure(input)) {
    const target = join(modulesDir, ...name.split("/"));
    if (existsSync(target)) continue;
    copyPackageTree(dir, target);
    copied.push(name);
  }
  return copied;
}

/**
 * Every package inside an assembled closure: the top level (hoisted layout) and
 * the pnpm virtual store (isolated layout). Package name → package directory.
 */
export function closurePackageDirs(modulesDir: string): Map<string, string> {
  const found = new Map<string, string>();
  const add = (name: string, dir: string): void => {
    if (found.has(name)) return;
    try {
      found.set(name, realpathSync(dir));
    } catch {
      found.set(name, dir);
    }
  };
  const collect = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: nothing to collect.
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        let scoped: Dirent[];
        try {
          scoped = readdirSync(path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of scoped) {
          if (!child.name.startsWith("."))
            add(`${entry.name}/${child.name}`, join(path, child.name));
        }
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) add(entry.name, path);
    }
  };
  collect(modulesDir);
  const virtual = join(modulesDir, ".pnpm");
  if (existsSync(virtual)) {
    for (const entry of readdirSync(virtual, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const layer = join(virtual, entry.name, "node_modules");
      if (existsSync(layer)) collect(layer);
    }
  }
  return found;
}

/**
 * Official packages referenced by an assembled closure but absent from it:
 * package name → the packages requiring it. `pnpm deploy --prod` installs no
 * peerDependencies, so a peer added by a newer upstream release only surfaces
 * here; optional peers are legitimately absent.
 */
export function missingOfficialPackages(modulesDir: string): Map<string, string[]> {
  const dirs = closurePackageDirs(modulesDir);
  const present = new Set(dirs.keys());
  const missing = new Map<string, string[]>();
  for (const [name, dir] of dirs) {
    if (!name.startsWith("@deepseek-ai/")) continue;
    const manifest = readManifest(dir);
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

/**
 * Dependency specs for the complete official surface of one workspace, used
 * for the dev project's manifest. A package that resolves to local sources
 * (a workspace member directory, so its version may be unpublished) is
 * referenced by its directory — never by a version — while a registry package
 * keeps a range on its resolved version. Throws when a package cannot be
 * located, naming the missing package.
 */
export function officialDependencySpecs(input: OfficialResolutionInput): Record<string, string> {
  const specs: Record<string, string> = {};
  const missing: string[] = [];
  // `dsh.version: workspace:*` means the app targets local sources: every
  // official package then comes from the workspace tree, not a registry.
  const localSources = input.dshVersion?.startsWith("workspace:") === true;
  for (const packageName of OFFICIAL_RUNTIME_PACKAGES) {
    if (packageName === DSH_PACKAGE && input.dshVersion !== undefined && !localSources) {
      specs[packageName] = input.dshVersion;
      continue;
    }
    if (packageName === DESKTOP_HOST_PACKAGE) {
      const host = desktopHost();
      if (host === undefined) {
        missing.push(packageName);
        continue;
      }
      specs[packageName] = `link:${host.dir}`;
      continue;
    }
    const resolved = resolveOfficialPackage(packageName, input);
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

/** Whether the workspace can load TypeScript sources through tsx. */
export function hasTsx(workspace: string, workspaceRoot: string): boolean {
  for (const dir of [workspace, workspaceRoot]) {
    try {
      createRequire(join(dir, "package.json")).resolve("tsx/esm");
      return true;
    } catch {
      // Try the next root.
    }
  }
  return false;
}
