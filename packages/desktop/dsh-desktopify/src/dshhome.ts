import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "./appconfig.ts";

export function xdgDataHome(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  const configured = process.env.XDG_DATA_HOME;
  if (configured !== undefined && configured.trim() !== "") return resolve(configured);
  return join(homedir(), ".local", "share");
}

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
