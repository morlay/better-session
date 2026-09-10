/**
 * Runtime configuration contract between the bundle step and the Electron shell.
 * Written beside the shell executable as `appconfig.json`; the shell reads it at
 * startup. `dshHome` follows the reference desktop semantics:
 *   - `xdg` (default) — XDG data home (`~/Library/Application Support` on
 *     macOS, `$XDG_DATA_HOME` on Linux) joined with the application name;
 *   - `env` — leave `DSH_HOME` unset and inherit the environment;
 *   - an absolute path — pin `DSH_HOME` to that directory.
 * @module @morlay/dsh-desktopify
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The dsh profile the desktop shell hosts (upstream desktop semantics). */
export const PROFILE_NAME = "desktop";

/** Window geometry carried from the workspace `dsh.desktop.window` field. */
export interface AppWindowConfig {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/** One complete shell runtime configuration. */
export interface AppConfig {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly profile: typeof PROFILE_NAME;
  /** `xdg` / `env` 或绝对路径（见 dshhome.ts 的解析语义）。 */
  readonly dshHome: string;
  readonly window: AppWindowConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function windowConfig(value: unknown): AppWindowConfig {
  const record = isRecord(value) ? value : {};
  return {
    width: numberOr(record.width, 1280),
    height: numberOr(record.height, 800),
    minWidth: numberOr(record.minWidth, 800),
    minHeight: numberOr(record.minHeight, 600),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Read and validate the shell configuration beside the executable. */
export function loadAppConfig(exeDir: string): AppConfig {
  const path = join(exeDir, "appconfig.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name === "" ||
    typeof value.id !== "string" ||
    value.id === "" ||
    typeof value.version !== "string" ||
    value.version === "" ||
    value.profile !== PROFILE_NAME ||
    (value.dshHome !== "xdg" && value.dshHome !== "env" && typeof value.dshHome !== "string")
  ) {
    throw new Error(`dsh desktop: invalid shell configuration ${path}`);
  }
  return {
    name: value.name,
    id: value.id,
    version: value.version,
    profile: PROFILE_NAME,
    dshHome: value.dshHome,
    window: windowConfig(value.window),
  };
}

/** Write the shell configuration beside the executable (bundle step). */
export function writeAppConfig(exeDir: string, config: AppConfig): void {
  writeFileSync(join(exeDir, "appconfig.json"), `${JSON.stringify(config, undefined, 2)}\n`, {
    mode: 0o600,
  });
}
