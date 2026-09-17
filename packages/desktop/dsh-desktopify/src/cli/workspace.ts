import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { OFFICIAL_PROFILE_BUNDLES } from "../official.ts";

export const PROFILE_NAME = "desktop";

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

export interface WorkspaceManifest {
  readonly name?: string;
  readonly version?: string;
  readonly files?: string[];
  readonly dependencies?: Record<string, string>;
  readonly dsh?: {
    readonly version?: string;
    readonly profile?: { readonly bundles?: unknown };
    readonly desktop?: {
      readonly id?: string;
      readonly dshHome?: string;
      readonly icon?: string;
      readonly window?: Record<string, number>;

      readonly agentPresets?: unknown;
    };

    readonly dev?: {
      readonly web?: {
        readonly clientBundles?: {
          readonly prefixes?: unknown;
          readonly packages?: unknown;
        };
      };
    };
  };
}

export type ResolvedWorkspaceManifest = WorkspaceManifest & { readonly name: string };

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkspace(): string {
  return resolve(process.cwd());
}

export async function workspaceManifest(workspace: string): Promise<ResolvedWorkspaceManifest> {
  const value = JSON.parse(
    await readFile(join(workspace, "package.json"), "utf8"),
  ) as WorkspaceManifest;
  if (typeof value.name !== "string" || value.name === "") {
    throw new Error(`dsh-desktopify: workspace ${workspace} has no package name`);
  }
  return { ...value, name: value.name };
}

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

export function appProfileBundles(manifest: WorkspaceManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.every((bundle) => typeof bundle === "string")) {
    throw new Error(
      `dsh-desktopify: workspace ${String(manifest.name)} has no dsh.profile.bundles`,
    );
  }
  return bundles as string[];
}

export function mergedProfileBundles(manifest: WorkspaceManifest): string[] {
  return [...OFFICIAL_PROFILE_BUNDLES, ...appProfileBundles(manifest)];
}

export interface DevWebConfig {
  readonly prefixes: string[];

  readonly packages: string[];
}

const DEFAULT_DEV_CLIENT_PREFIXES = ["@morlay/"];

function devStringList(subject: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new Error(`dsh-desktopify: ${subject} must be a non-empty string list`);
  }
  return value as string[];
}

export function devWebConfig(manifest: WorkspaceManifest): DevWebConfig | undefined {
  const value = manifest.dsh?.dev?.web?.clientBundles;
  if (value === undefined) return undefined;
  const subject = `workspace ${String(manifest.name)} dsh.dev.web.clientBundles`;
  return {
    prefixes:
      value.prefixes === undefined
        ? [...DEFAULT_DEV_CLIENT_PREFIXES]
        : devStringList(`${subject}.prefixes`, value.prefixes),
    packages:
      value.packages === undefined ? [] : devStringList(`${subject}.packages`, value.packages),
  };
}

export async function findWorkspaceRoot(workspace: string): Promise<string> {
  let current = resolve(workspace);
  for (;;) {
    if (await pathExists(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current)
      throw new Error(`dsh-desktopify: no pnpm-workspace.yaml found above ${workspace}`);
    current = parent;
  }
}

export function buildRoot(workspace: string): string {
  return join(workspace, "node_modules", ".dsh-desktopify");
}

export function cleanDeployedSpec(spec: string): string {
  const suffix = spec.indexOf("(");
  return suffix === -1 ? spec : spec.slice(0, suffix);
}

const DEPLOY_SETTINGS_KEYS = new Set([
  "minimumReleaseAge",
  "minimumReleaseAgeExclude",
  "minimumReleaseAgeIgnoreMissingTime",
  "minimumReleaseAgeStrict",
  "nodeLinker",
  "autoInstallPeers",
]);

const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]|$)/u;

function splitLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").split("\n");
}

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

    index = block.end;
  }
  while (merged.length > 0 && (merged[merged.length - 1] ?? "").trim() === "") merged.pop();
  for (const [key, lines] of inherited) {
    if (!replaced.has(key)) merged.push(...lines);
  }
  return merged.length === 0 ? "" : `${merged.join("\n")}\n`;
}

export async function packageVersion(path: string, subject: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as { version?: string };
  if (typeof manifest.version !== "string")
    throw new Error(`dsh-desktopify: ${subject} has no version`);
  return manifest.version;
}
