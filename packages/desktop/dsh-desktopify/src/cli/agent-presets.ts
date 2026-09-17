import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DSH_PACKAGE } from "./official-deps.ts";
import { mergedProfileBundles, type WorkspaceManifest } from "./workspace.ts";

const PRESET_MOUNT = "config/agent-presets";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function agentPresetMount(projectDir: string): string {
  return join(projectDir, "node_modules", ...DSH_PACKAGE.split("/"), ...PRESET_MOUNT.split("/"));
}

async function presetSourceDir(modulesDir: string, spec: string): Promise<string> {
  const segments = spec.split("/").filter((segment) => segment !== "");
  const scoped = spec.startsWith("@");
  const packageSegments = segments.slice(0, scoped ? 2 : 1);
  const subpath = segments.slice(scoped ? 2 : 1);
  const dir = join(modulesDir, ...packageSegments, ...subpath);
  if (!(await pathExists(dir))) {
    throw new Error(
      `dsh-desktopify: desktop agent preset source ${JSON.stringify(spec)} is missing (${dir})`,
    );
  }
  return dir;
}

async function declaredPresetTrees(packageDir: string, bundle: string): Promise<string[]> {
  const manifestPath = join(packageDir, "package.json");
  if (!(await pathExists(manifestPath))) return [];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dsh?: { configTrees?: unknown };
  };
  const declared = manifest.dsh?.configTrees;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    throw new Error(`dsh-desktopify: ${bundle} dsh.configTrees must be an array`);
  }
  const dirs: string[] = [];
  for (const [index, entry] of declared.entries()) {
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
    if (tree.mount !== PRESET_MOUNT) continue;
    const dir = join(packageDir, ...tree.path.split("/"));
    if (await pathExists(dir)) dirs.push(dir);
  }
  return dirs;
}

export async function discoverPresetMounts(
  manifest: WorkspaceManifest,
  modulesDir: string,
  explicitSpecs: readonly string[],
): Promise<string[]> {
  const sources: string[] = [];
  for (const bundle of mergedProfileBundles(manifest)) {
    sources.push(...(await declaredPresetTrees(join(modulesDir, ...bundle.split("/")), bundle)));
  }
  for (const spec of explicitSpecs) sources.push(await presetSourceDir(modulesDir, spec));
  return sources;
}

export async function materializeAgentPresets(
  projectDir: string,
  sources: readonly string[],
): Promise<void> {
  if (sources.length === 0) return;
  const target = agentPresetMount(projectDir);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const source of sources) {
    await cp(source, target, { recursive: true, dereference: true });
  }
}
