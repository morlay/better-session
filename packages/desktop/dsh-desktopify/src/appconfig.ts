import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PROFILE_NAME = "desktop";

export interface AppWindowConfig {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

export interface AppConfig {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly profile: typeof PROFILE_NAME;

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

export async function loadAppConfig(exeDir: string): Promise<AppConfig> {
  const path = join(exeDir, "appconfig.json");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
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

export async function writeAppConfig(exeDir: string, config: AppConfig): Promise<void> {
  await writeFile(join(exeDir, "appconfig.json"), `${JSON.stringify(config, undefined, 2)}\n`, {
    mode: 0o600,
  });
}
