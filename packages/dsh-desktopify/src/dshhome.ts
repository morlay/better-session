/**
 * Resolve the runtime `DSH_HOME` from the shell configuration, following the
 * reference desktop semantics: `xdg` maps to the XDG data home
 * (`~/Library/Application Support` on macOS, `$XDG_DATA_HOME` or
 * `~/.local/share` on Linux) joined with the application name, so the packaged
 * app shares the same data root as the reference implementation and never
 * touches the workspace. `env` inherits the environment; an absolute path pins
 * the home. `DSH_APP_DSH_HOME` overrides everything (development and tests).
 * @module @morlay/dsh-desktopify
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "./appconfig.ts";

/** XDG data home for the current platform (macOS and Linux). */
export function xdgDataHome(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  const configured = process.env.XDG_DATA_HOME;
  if (configured !== undefined && configured.trim() !== "") return resolve(configured);
  return join(homedir(), ".local", "share");
}

/**
 * Resolve the runtime `DSH_HOME` for one shell configuration.
 * @param config - shell configuration read beside the executable.
 * @returns the absolute home, or `undefined` when the strategy is `env`
 * (the caller then leaves `DSH_HOME` unset).
 */
export function resolveDshHome(config: AppConfig): string | undefined {
  const override = process.env.DSH_APP_DSH_HOME;
  if (override !== undefined && override.trim() !== "") return resolve(override);
  if (config.dshHome === "env") return undefined;
  if (config.dshHome === "xdg") return join(xdgDataHome(), config.name);
  if (!isAbsolute(config.dshHome)) {
    throw new Error(
      `dsh desktop: dshHome must be xdg, env, or an absolute path, got ${JSON.stringify(config.dshHome)}`,
    );
  }
  return config.dshHome;
}
