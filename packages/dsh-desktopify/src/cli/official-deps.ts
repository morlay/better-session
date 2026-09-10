/**
 * Official `@deepseek-ai/*` dependency resolution for one target workspace.
 *
 * The app declares only its own dependencies plus `dsh.version` (the
 * `@deepseek-ai/dsh` dependency spec it targets); the tool maintains the
 * official surface (`../official.ts`). Specs are derived from the packages
 * actually installed — the app workspace first, then the tool's own install —
 * so nothing hardcodes the `workspace:` protocol and an app outside this
 * repository resolves the same way:
 *   - `@deepseek-ai/dsh` → `dsh.version` when declared (concrete version,
 *     range, or `workspace:` in-tree), else `^<resolved>`;
 *   - `@deepseek-ai/dsh-desktop-host` → `link:<dir>`, or a staged `file:`
 *     copy when the host lives outside the app workspace (the host is not
 *     published, so it always comes from the tool);
 *   - every other official package → `^<resolved>`.
 *
 * `hasTsx` reports whether the workspace can load TypeScript sources directly;
 * the tool only injects `--import=tsx/esm` when it can.
 * @module @morlay/dsh-desktopify
 */

import { cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { OFFICIAL_RUNTIME_PACKAGES } from "../official.ts";

/** Installation anchor the upstream desktop host resolves profile bundles from. */
export const DSH_PACKAGE = "@deepseek-ai/dsh";

/** Private byte-pipe backend installed beside dsh; never published to a registry. */
export const DESKTOP_HOST_PACKAGE = "@deepseek-ai/dsh-desktop-host";

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
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const value = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
      if (typeof value.version === "string" && value.version !== "") {
        return { dir: realpathSync(dir), version: value.version };
      }
    } catch {
      // Unreadable manifest: try the next root.
    }
  }
  return undefined;
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

/**
 * Dependency specs for the complete official surface of one workspace.
 * Throws when a package cannot be located, naming the missing package.
 */
export function officialDependencySpecs(input: OfficialResolutionInput): Record<string, string> {
  const specs: Record<string, string> = {};
  const missing: string[] = [];
  for (const packageName of OFFICIAL_RUNTIME_PACKAGES) {
    const resolved = resolveOfficialPackage(packageName, input);
    if (packageName === DSH_PACKAGE && input.dshVersion !== undefined) {
      // `dsh.version` is the app-configured dsh spec (concrete or `workspace:`).
      specs[packageName] = input.dshVersion;
      continue;
    }
    if (resolved === undefined) {
      missing.push(packageName);
      continue;
    }
    if (packageName === DESKTOP_HOST_PACKAGE) {
      specs[packageName] = `link:${resolved.dir}`;
      continue;
    }
    specs[packageName] = `^${resolved.version}`;
  }
  if (missing.length > 0) {
    throw new Error(
      `dsh-desktopify: cannot resolve official packages ${missing.join(", ")}; ` +
        "install them in the workspace or run from the tool's own install",
    );
  }
  return specs;
}

/** Whether `candidate` is `root` itself or nested under it. */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Dependency spec for the private desktop host in a `pnpm deploy` closure.
 *
 * In-repo the host lives inside the same pnpm workspace, so a `link:` spec is
 * copied by deploy. When the app workspace is elsewhere, `pnpm deploy` refuses
 * paths outside it: stage a copy inside the app workspace (with the host's
 * `workspace:` dependencies rewritten to the specs already computed) and use a
 * `file:` spec. The staged directory is temporary and removed by the caller.
 */
export function stageDesktopHost(
  input: OfficialResolutionInput,
  specs: Readonly<Record<string, string>>,
): string {
  const host = resolveOfficialPackage(DESKTOP_HOST_PACKAGE, input);
  if (host === undefined) {
    throw new Error(`dsh-desktopify: cannot resolve ${DESKTOP_HOST_PACKAGE}`);
  }
  if (isInside(input.workspaceRoot, host.dir)) return `link:${host.dir}`;
  const staged = join(input.workspace, ".dsh-desktopify-host");
  rmSync(staged, { recursive: true, force: true });
  cpSync(host.dir, staged, {
    recursive: true,
    dereference: true,
    // 只跳过包内嵌套的 node_modules，包根自身可能就在 node_modules 下。
    filter: (source) => {
      const rel = relative(host.dir, source);
      return rel === "" || !rel.split(/[\\/]/u).includes("node_modules");
    },
  });
  const manifestPath = join(staged, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  for (const field of ["dependencies", "peerDependencies"] as const) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      const resolved = resolveOfficialPackage(name, input);
      const configured = specs[name];
      // 暂存副本在工作区外，`workspace:` spec 必须落成具体版本。
      const replacement =
        configured === undefined || configured.startsWith("workspace:")
          ? resolved === undefined
            ? undefined
            : `^${resolved.version}`
          : configured;
      if (replacement !== undefined && !replacement.startsWith("link:")) {
        (dependencies as Record<string, string>)[name] = replacement;
      }
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  return "file:./.dsh-desktopify-host";
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
