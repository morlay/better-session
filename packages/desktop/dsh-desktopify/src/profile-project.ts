/** Desktop profile project: the files the seed ships and the package operations the launcher runs on them.
 *
 * 种子里只带 app 自己的 bundle（`file:` 指向随包 `vendor/` 副本）；官方包与 dsh 由不可变的
 * runtime 提供，profile 里对这些包的依赖通过 `overrides` 以 `link:` 指回 runtime，因此安装
 * 不需要 registry，也不复制运行时闭包。
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Profile pnpm settings file the launcher appends run-time `overrides` to. */
export const PROFILE_WORKSPACE_NAME = "pnpm-workspace.yaml";

/** Seed-written report naming the runtime packages the profile resolves through `overrides`. */
export const PROFILE_RUNTIME_REPORT_NAME = "desktop-runtime-packages.json";

/** Profile directory holding the `file:` sources of the profile's own bundles. */
export const PROFILE_VENDOR_DIR_NAME = "vendor";

/** One package the profile dependency graph links to the installed runtime. */
export interface RuntimeOverride {
  /** Package name as it appears in the profile's dependency graph. */
  readonly name: string;
  /** Absolute directory inside the installed runtime holding that package. */
  readonly target: string;
}

const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]|$)/u;

/**
 * Read the seed's runtime package report and point each entry at the installed runtime.
 * @param profileDir - profile directory holding the seed-written report.
 * @param runtimeDir - runtime root the report's paths are relative to.
 * @returns one `link:` override per reported package, in report order.
 * @throws when the report is missing, malformed, or holds an invalid entry.
 */
export async function runtimeOverrides(
  profileDir: string,
  runtimeDir: string,
): Promise<RuntimeOverride[]> {
  const report = JSON.parse(
    await readFile(join(profileDir, PROFILE_RUNTIME_REPORT_NAME), "utf8"),
  ) as { runtimePackages?: unknown };
  const entries = report.runtimePackages;
  if (!Array.isArray(entries) || !entries.every(isRuntimePackage)) {
    throw new Error(
      `dsh desktop: ${PROFILE_RUNTIME_REPORT_NAME} has an invalid runtimePackages list`,
    );
  }
  return entries.map((entry) => ({
    name: entry.name,
    target: join(runtimeDir, ...entry.path.split("/")),
  }));
}

/** One reported runtime package: its dependency name and its runtime-relative directory. */
function isRuntimePackage(
  value: unknown,
): value is { readonly name: string; readonly path: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; path?: unknown };
  return (
    typeof candidate.name === "string" &&
    candidate.name !== "" &&
    typeof candidate.path === "string" &&
    candidate.path !== ""
  );
}

/**
 * Write the runtime overrides into profile pnpm settings, replacing an earlier generation.
 * An empty override list leaves the file untouched, so a hand-edited block survives launches
 * whose seed reported no runtime package.
 * @param text - current profile pnpm settings.
 * @param overrides - runtime packages to link.
 * @returns the settings text to write.
 */
export function workspaceWithOverrides(
  text: string,
  overrides: readonly RuntimeOverride[],
): string {
  if (overrides.length === 0) return text;
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const key = TOP_LEVEL_KEY.exec(line)?.[1];
    if (key !== undefined) skipping = key === "overrides";
    if (!skipping) kept.push(line);
  }
  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") kept.pop();
  const block = [
    "overrides:",
    ...overrides.map(
      (entry) => `  ${JSON.stringify(entry.name)}: ${JSON.stringify(`link:${entry.target}`)}`,
    ),
  ];
  return `${[...kept, ...block].join("\n")}\n`;
}

/** Injection point for the profile installation process. */
export type ProfileInstallSpawn = typeof spawn;

/** Inputs for one offline profile installation. */
export interface ProfileInstallOptions {
  /** Bundled Node.js executable running pnpm. */
  readonly node: string;
  /** Bundled pnpm entry (`.mjs`) inside the runtime. */
  readonly pnpmEntry: string;
  /** Profile directory whose dependencies are installed. */
  readonly profileDir: string;
  /** Process launcher, injectable for tests. */
  readonly spawn?: ProfileInstallSpawn;
}

/**
 * Install the profile's own bundles offline from the seed's `file:` sources.
 * @param options - bundled executables, profile directory, and process launcher.
 * @throws when pnpm cannot start or exits non-zero, with its diagnostics tail.
 */
export function installProfile(options: ProfileInstallOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const spawnChild = options.spawn ?? spawn;
    const child = spawnChild(
      options.node,
      [options.pnpmEntry, "install", "--prod", "--ignore-scripts", "--offline"],
      { cwd: options.profileDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    // 消费 stdout，避免管道回压把 pnpm 卡在写日志上。
    child.stdout?.on("data", () => undefined);
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const diagnostic = stderr.trim();
      reject(
        new Error(
          `dsh desktop: profile install exited with ${String(code)}` +
            `${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
}
