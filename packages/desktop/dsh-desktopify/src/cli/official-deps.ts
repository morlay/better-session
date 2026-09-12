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
 * `materializeOfficialClosure` copies the part of it pnpm cannot install in the
 * deploy project — local source packages and the bundled host — so the packaged
 * profile carries the complete official tree without ever rewriting the target
 * workspace's manifest or lockfile. The registry part of the surface goes into
 * the deploy project's own manifest (`officialDeploySpecs`) and is installed by
 * pnpm, which owns npm's file-set semantics: `files` never excludes `main`,
 * `bin`, README or LICENSE.
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
  /**
   * `node_modules` of the closure being assembled (the deploy project, then the
   * seed), only set while that closure already exists: it is also a resolution
   * root, so an official package the tool installed into the deploy project
   * counts as resolved instead of failing the walk.
   */
  readonly closureModulesDir?: string;
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
 * the app's own install, its pnpm virtual store, the closure under assembly,
 * the tool's install, and the tool's surrounding install (the repository store
 * in-tree, the app's `node_modules` when the tool is installed as a dependency).
 */
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
 * package directory. Throws when an official root, or a hard `dependencies`
 * entry of an official package, cannot be located: an unresolvable peer (tsx,
 * electron, …) is provided by the consumer, and a platform-specific optional
 * dependency only exists for its own platform, so both are skipped.
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
        // peer 依赖由消费方提供（tsx、electron），optional 依赖按平台/架构只装得上
        // 当前那一个（node-addon-system 声明四个平台包，本机只有其中一个）：两者缺了
        // 都正常，只有硬依赖缺失才说明官方闭包真的不完整。
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
 * The payload entries of a **source** package directory: its manifest `files`
 * whitelist when declared (so a vendored source package ships its built output,
 * not its sources), the whole directory otherwise. Never applies to a registry
 * installation — see `copyPackageTree`.
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

/** Whether a package directory is an installation (`…/node_modules/<pkg>`). */
function isInstalledPackage(dir: string): boolean {
  return dir.split(/[\\/]/u).includes("node_modules");
}

/**
 * Copy one package directory into the closure, skipping nested `node_modules`.
 *
 * An installation is copied whole: npm's `files` is not the tarball's file list
 * — `main`, `bin`, README and LICENSE are packed whether or not `files` names
 * them (`@img/colour` declares `files: ["color.cjs","index.d.ts"]` while its
 * `main` is `index.cjs`), so filtering one would cut files the runtime loads.
 * A local source package keeps its `files` whitelist: it lives in the
 * repository as sources, and only its declared built output belongs in the
 * seed.
 */
export function copyPackageTree(source: string, target: string): void {
  const payload = isInstalledPackage(source) ? undefined : packagePayload(source);
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
 * Copy into an assembled closure what pnpm did not install: the official
 * packages living in source trees (their `workspace:` dependencies cannot be
 * resolved inside the deploy project) and the tool's bundled desktop host.
 * Whatever pnpm already installed there wins on conflicts. The closure itself
 * joins the resolution roots, so an official package the tool installed into
 * the deploy project is part of the walk instead of being reported as
 * unresolvable. Returns the copied package names.
 */
export function materializeOfficialClosure(
  modulesDir: string,
  input: OfficialResolutionInput,
): string[] {
  const copied: string[] = [];
  for (const [name, dir] of officialClosure({ ...input, closureModulesDir: modulesDir })) {
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

/**
 * Dependency specs pnpm itself materializes inside the deploy project: the part
 * of the official surface that resolves to registry packages. A package the app
 * targets by version keeps that version, a package the workspace installed
 * keeps a range on its resolved version, and a harness-versioned package
 * (`@deepseek-ai/dsh*`) the workspace cannot resolve at all takes
 * `fallbackVersion` (the version the app targets). An official package with its
 * own version line (`@deepseek-ai/cordis-plugin-group`, 1.x) is never guessed:
 * without a resolution it stays out, and the closure walk reports it.
 *
 * Two kinds of official packages stay out of it, because a deploy-project
 * install cannot resolve them: a local source package and the bundled desktop
 * host both declare `workspace:` dependencies of the app's own workspace, and
 * the deploy project is not that workspace root (pnpm then fails with "no
 * package named … is present in the workspace"). The closure walk copies those
 * into the closure afterwards.
 */
export function officialDeploySpecs(
  input: OfficialResolutionInput,
  fallbackVersion?: string,
): Record<string, string> {
  const specs: Record<string, string> = {};
  // `dsh.version: workspace:*` means the app targets local sources: none of the
  // official surface is installable, and the closure walk owns all of it.
  if (input.dshVersion?.startsWith("workspace:") === true) return specs;
  for (const packageName of OFFICIAL_RUNTIME_PACKAGES) {
    if (packageName === DSH_PACKAGE && input.dshVersion !== undefined) {
      specs[packageName] = input.dshVersion;
      continue;
    }
    if (packageName === DESKTOP_HOST_PACKAGE) continue;
    const resolved = resolveOfficialPackage(packageName, input);
    if (resolved === undefined) {
      // 工作区没有这个包（如仓库外 app 缺的实验包）：只有 harness 版本化的包
      // （`@deepseek-ai/dsh*`，含实验包）能用 app 的目标版本补装；其余官方包
      // （如独立 1.x 版本线的 @deepseek-ai/cordis-plugin-group）不猜版本，留给闭包
      // walk 报「装不上」，而不是装出一个不存在的版本。
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
