/**
 * Desktop agent presets: the desktop host pins `agent-presets.roots` to
 * `<project>/node_modules/@deepseek-ai/dsh/config/agent-presets` (a `system`
 * root), so a preset directory the app ships anywhere else never reaches the
 * roster. Two sources fill that mount while the tool assembles the profile: a
 * profile bundle declares its own trees (`dsh.configTrees`, the upstream field,
 * so a preset package carries its presets), and the app may add or override
 * directories explicitly (`dsh.desktop.agentPresets`, applied last).
 * @module @morlay/dsh-desktopify
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DSH_PACKAGE } from "./official-deps.ts";
import { mergedProfileBundles, type WorkspaceManifest } from "./workspace.ts";

/** Mount the desktop host reads presets from, relative to the installed dsh package. */
const PRESET_MOUNT = "config/agent-presets";

/** Absolute mount path inside one assembled project. */
export function agentPresetMount(projectDir: string): string {
  return join(projectDir, "node_modules", ...DSH_PACKAGE.split("/"), ...PRESET_MOUNT.split("/"));
}

/** Resolve one explicit preset spec (`@scope/pkg/sub/dir`) inside the project's closure. */
function presetSourceDir(modulesDir: string, spec: string): string {
  const segments = spec.split("/").filter((segment) => segment !== "");
  const scoped = spec.startsWith("@");
  const packageSegments = segments.slice(0, scoped ? 2 : 1);
  const subpath = segments.slice(scoped ? 2 : 1);
  const dir = join(modulesDir, ...packageSegments, ...subpath);
  if (!existsSync(dir)) {
    throw new Error(
      `dsh-desktopify: desktop agent preset source ${JSON.stringify(spec)} is missing (${dir})`,
    );
  }
  return dir;
}

/**
 * The preset directories one profile bundle declares for the desktop mount
 * (`dsh.configTrees`, upstream's field: `path` is relative to the package root,
 * `mount` is the image path). A tree whose directory does not exist is skipped
 * — the declaration may point outside the package, as the registry `dsh` does.
 * A malformed declaration refuses the assembly: it would otherwise drop presets
 * silently.
 */
function declaredPresetTrees(packageDir: string, bundle: string): string[] {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dsh?: { configTrees?: unknown };
  };
  const declared = manifest.dsh?.configTrees;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    throw new Error(`dsh-desktopify: ${bundle} dsh.configTrees must be an array`);
  }
  const dirs: string[] = [];
  declared.forEach((entry: unknown, index: number) => {
    const tree = entry as { mount?: unknown; path?: unknown } | null;
    if (
      tree === null ||
      typeof tree !== "object" ||
      typeof tree.mount !== "string" ||
      tree.mount === "" ||
      typeof tree.path !== "string" ||
      tree.path === ""
    ) {
      throw new Error(
        `dsh-desktopify: ${bundle} dsh.configTrees[${String(index)}] must declare a string mount and a string path`,
      );
    }
    if (tree.mount !== PRESET_MOUNT) return;
    const dir = join(packageDir, ...tree.path.split("/"));
    if (existsSync(dir)) dirs.push(dir);
  });
  return dirs;
}

/**
 * The preset source directories of one assembled profile, in copy order: the
 * trees the profile bundles declare first, then the app's explicit specs — so
 * an explicit declaration overrides a declared tree of the same name.
 */
export function discoverPresetMounts(
  manifest: WorkspaceManifest,
  modulesDir: string,
  explicitSpecs: readonly string[],
): string[] {
  const sources: string[] = [];
  for (const bundle of mergedProfileBundles(manifest)) {
    sources.push(...declaredPresetTrees(join(modulesDir, ...bundle.split("/")), bundle));
  }
  for (const spec of explicitSpecs) sources.push(presetSourceDir(modulesDir, spec));
  return sources;
}

/**
 * Replace the project's preset mount with the discovered preset directories.
 * Presets are copied (never linked): the packaged profile is copied into the
 * runtime home, where a link into the build tree would dangle.
 */
export function materializeAgentPresets(projectDir: string, sources: readonly string[]): void {
  if (sources.length === 0) return;
  const target = agentPresetMount(projectDir);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const source of sources) {
    cpSync(source, target, { recursive: true, dereference: true });
  }
}
