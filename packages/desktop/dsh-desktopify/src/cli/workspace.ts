/**
 * Shared workspace resolution for the desktopify scripts: the workspace is
 * never hardcoded — it comes from `DSH_DESKTOP_WORKSPACE` (or the CLI
 * positional argument, which the CLI forwards through that variable) and
 * defaults to the current directory. Also carries the app-facing contract:
 * `dsh.desktop` identity and the merged profile bundle list.
 * @module @morlay/dsh-desktopify
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OFFICIAL_PROFILE_BUNDLES } from "../official.ts";

/** The dsh profile the desktop shell hosts (upstream desktop semantics). */
export const PROFILE_NAME = "desktop";

/** App-facing `dsh.desktop` configuration with tool defaults. */
export interface DesktopConfig {
  readonly id: string;
  readonly version: string;
  readonly dshHome: string;
  readonly window: {
    readonly width: number;
    readonly height: number;
    readonly minWidth: number;
    readonly minHeight: number;
  };
  readonly icon?: string;
}

/** The app workspace manifest (package.json). */
export interface WorkspaceManifest {
  readonly name?: string;
  readonly version?: string;
  readonly files?: string[];
  readonly dependencies?: Record<string, string>;
  readonly dsh?: {
    /** dsh runtime release the app targets (`dsh.version`). */
    readonly version?: string;
    readonly profile?: { readonly bundles?: unknown };
    readonly desktop?: {
      readonly id?: string;
      readonly dshHome?: string;
      readonly icon?: string;
      readonly window?: Record<string, number>;
      /** Preset directories the desktop profile distributes (package specs). */
      readonly agentPresets?: unknown;
    };
  };
}

/** A manifest whose required fields have been validated. */
export type ResolvedWorkspaceManifest = WorkspaceManifest & { readonly name: string };

/** Resolve the app workspace directory (default: the current directory). */
export function resolveWorkspace(): string {
  return resolve(process.cwd());
}

/** Read and validate the workspace manifest. */
export function workspaceManifest(workspace: string): ResolvedWorkspaceManifest {
  const value = JSON.parse(
    readFileSync(join(workspace, "package.json"), "utf8"),
  ) as WorkspaceManifest;
  if (typeof value.name !== "string" || value.name === "") {
    throw new Error(`dsh-desktopify: workspace ${workspace} has no package name`);
  }
  return { ...value, name: value.name };
}

/**
 * The `@deepseek-ai/dsh` dependency spec the app targets (`dsh.version`): a
 * concrete release (`0.1.5-rc.1`), a range, or the `workspace:` protocol when
 * the app lives in the same workspace as the vendored dsh.
 */
export function dshVersion(manifest: WorkspaceManifest): string | undefined {
  const version = manifest.dsh?.version;
  if (version === undefined) return undefined;
  if (typeof version !== "string" || version === "") {
    throw new Error(
      `dsh-desktopify: workspace ${String(manifest.name)} has an invalid dsh.version ` +
        `(expected a dependency spec such as "0.1.5-rc.1" or "workspace:^")`,
    );
  }
  return version;
}

/** The app's `dsh.desktop` configuration with tool defaults. */
export function desktopConfig(manifest: WorkspaceManifest): DesktopConfig {
  const desktop = manifest.dsh?.desktop ?? {};
  const window = desktop.window ?? {};
  return {
    id: desktop.id ?? "ai.deepseek.dsh.custom",
    version: manifest.version ?? "0.0.1",
    dshHome: desktop.dshHome ?? "xdg",
    window: {
      width: window.width ?? 1280,
      height: window.height ?? 800,
      minWidth: window.minWidth ?? 800,
      minHeight: window.minHeight ?? 600,
    },
    ...(desktop.icon === undefined ? {} : { icon: desktop.icon }),
  };
}

/**
 * The app's desktop-distributed agent preset directories: package specs such
 * as `@scope/pkg/presets`, resolved inside the assembled profile's closure.
 */
export function desktopAgentPresets(manifest: WorkspaceManifest): string[] {
  const value = manifest.dsh?.desktop?.agentPresets;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((spec) => typeof spec === "string" && spec !== "")) {
    throw new Error(
      `dsh-desktopify: workspace ${String(manifest.name)} has an invalid ` +
        `dsh.desktop.agentPresets (expected package specs such as "@scope/pkg/presets")`,
    );
  }
  return value as string[];
}

/** The app's declared profile bundles (validated). */
export function appProfileBundles(manifest: WorkspaceManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.every((bundle) => typeof bundle === "string")) {
    throw new Error(
      `dsh-desktopify: workspace ${String(manifest.name)} has no dsh.profile.bundles`,
    );
  }
  return bundles as string[];
}

/** Official bundles merged ahead of the app's own bundles. */
export function mergedProfileBundles(manifest: WorkspaceManifest): string[] {
  return [...OFFICIAL_PROFILE_BUNDLES, ...appProfileBundles(manifest)];
}

/** Find the pnpm workspace root above a directory. */
export function findWorkspaceRoot(workspace: string): string {
  let current = resolve(workspace);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current)
      throw new Error(`dsh-desktopify: no pnpm-workspace.yaml found above ${workspace}`);
    current = parent;
  }
}

/** The tool's build cache root inside the target workspace. */
export function buildRoot(workspace: string): string {
  return join(workspace, "node_modules", ".dsh-desktopify");
}

/**
 * Top-level `pnpm-workspace.yaml` keys the deployed project inherits from the
 * workspace. `pnpm deploy` only carries the settings that shape the closure
 * assembly (`allowBuilds`, `patchedDependencies`, `overrides`); the resolution
 * and supply-chain settings stay behind, so an install inside the deployed
 * project silently falls back to pnpm's defaults — under pnpm 12's
 * `minimumReleaseAge=1440` (strict) a freshly published dependency then fails
 * the lockfile supply-chain check. Whitelisted only: member globs (`packages`)
 * and workspace-topology settings stay with the workspace.
 */
const DEPLOY_SETTINGS_KEYS = new Set([
  "minimumReleaseAge",
  "minimumReleaseAgeExclude",
  "minimumReleaseAgeIgnoreMissingTime",
  "minimumReleaseAgeStrict",
  "nodeLinker",
  "autoInstallPeers",
]);

/** 顶层键行：行首无空白且以 `key:` 开头（不会把 `minimumReleaseAgeExclude` 认成 `minimumReleaseAge`）。 */
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]|$)/u;

/** 文本行切分（CRLF 归一化；尾随换行留下一个空行，由输出端裁掉）。 */
function splitLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").split("\n");
}

/**
 * 顶层键块：键行 + 紧随其后的缩进行（列表/映射都是缩进行）。空行不属于任何
 * 块，块内空行因此不会被搬走。
 */
function topLevelBlocks(lines: readonly string[]): { key: string; start: number; end: number }[] {
  const blocks: { key: string; start: number; end: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = TOP_LEVEL_KEY.exec(lines[index] ?? "");
    if (match === null) continue;
    let end = index;
    while (/^[ \t]/u.test(lines[end + 1] ?? "")) end += 1;
    blocks.push({ key: match[1] ?? "", start: index, end });
    index = end;
  }
  return blocks;
}

/**
 * Merge the workspace settings the deployed project must keep into the
 * manifest `pnpm deploy` generated for it: every whitelisted top-level key
 * declared in `source` (the key line plus its indented block — scalar, list or
 * mapping) replaces the same key in `destination`, or is appended at the end
 * when absent. Everything else in `destination` is preserved verbatim and no
 * duplicate key is ever produced. Returns the merged manifest with a single
 * trailing newline.
 */
export function mergedDeploySettings(source: string, destination: string): string {
  const sourceLines = splitLines(source);
  const inherited = new Map<string, string[]>();
  for (const block of topLevelBlocks(sourceLines)) {
    if (!DEPLOY_SETTINGS_KEYS.has(block.key)) continue;
    inherited.set(block.key, sourceLines.slice(block.start, block.end + 1));
  }

  const destinationLines = splitLines(destination);
  const starts = new Map(topLevelBlocks(destinationLines).map((block) => [block.start, block]));
  const merged: string[] = [];
  const replaced = new Set<string>();
  for (let index = 0; index < destinationLines.length; index += 1) {
    const block = starts.get(index);
    if (block === undefined) {
      merged.push(destinationLines[index] ?? "");
      continue;
    }
    const replacement = inherited.get(block.key);
    if (replacement === undefined) {
      merged.push(...destinationLines.slice(index, block.end + 1));
    } else if (!replaced.has(block.key)) {
      merged.push(...replacement);
      replaced.add(block.key);
    }
    // 重复出现的同名键：整块丢掉，保证输出里最多一个键。
    index = block.end;
  }
  while (merged.length > 0 && (merged[merged.length - 1] ?? "").trim() === "") merged.pop();
  for (const [key, lines] of inherited) {
    if (!replaced.has(key)) merged.push(...lines);
  }
  return merged.length === 0 ? "" : `${merged.join("\n")}\n`;
}

/** Read a package's version from its manifest. */
export function packageVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
  if (typeof manifest.version !== "string")
    throw new Error(`dsh-desktopify: ${subject} has no version`);
  return manifest.version;
}
