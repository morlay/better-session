/**
 * Desktop agent presets: the desktop host pins `agent-presets.roots` to
 * `<project>/node_modules/@deepseek-ai/dsh/config/agent-presets` (a `system`
 * root), so a preset directory the app ships anywhere else never reaches the
 * roster. The app declares those directories as package specs
 * (`dsh.desktop.agentPresets`) and the tool materializes their content into
 * that mount while it assembles the profile.
 * @module @morlay/dsh-desktopify
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DSH_PACKAGE } from "./official-deps.ts";

/** Mount the desktop host reads presets from, relative to the installed dsh package. */
const PRESET_MOUNT: readonly string[] = ["config", "agent-presets"];

/** Absolute mount path inside one assembled project. */
export function agentPresetMount(projectDir: string): string {
  return join(projectDir, "node_modules", ...DSH_PACKAGE.split("/"), ...PRESET_MOUNT);
}

/** Resolve one preset spec (`@scope/pkg/sub/dir`) inside the project's closure. */
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
 * Replace the project's preset mount with the declared preset directories.
 * Presets are copied (never linked): the packaged profile is copied into the
 * runtime home, where a link into the build tree would dangle.
 */
export function materializeAgentPresets(projectDir: string, specs: readonly string[]): void {
  if (specs.length === 0) return;
  const modulesDir = join(projectDir, "node_modules");
  const target = agentPresetMount(projectDir);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const spec of specs) {
    cpSync(presetSourceDir(modulesDir, spec), target, { recursive: true, dereference: true });
  }
}
