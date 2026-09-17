import { isEmptyRules, type CompiledRules } from "./rules.ts";

export type SandboxDialect = "seatbelt" | "bwrap" | "landlock" | "windows-acl";

const SEPARATOR = "--";

export interface DialectCapabilities {
  readonly allowWrite: boolean;

  readonly readOnly: boolean;

  readonly denyReadWrite: boolean;

  readonly denyWriteOnly: boolean;
}

export const DIALECT_CAPABILITIES: Record<SandboxDialect, DialectCapabilities> = {
  seatbelt: { allowWrite: true, readOnly: true, denyReadWrite: true, denyWriteOnly: false },
  bwrap: { allowWrite: true, readOnly: true, denyReadWrite: false, denyWriteOnly: true },
  landlock: { allowWrite: true, readOnly: false, denyReadWrite: false, denyWriteOnly: false },
  "windows-acl": { allowWrite: false, readOnly: false, denyReadWrite: false, denyWriteOnly: false },
};

function separatorIndex(argv: readonly string[]): number {
  const index = argv.indexOf(SEPARATOR);
  if (index === -1) {
    throw new Error("sandbox rules: the confined argv carries no `--` separator to extend");
  }
  return index;
}

export function dialectOf(argv: readonly string[]): SandboxDialect | undefined {
  const separator = argv.indexOf(SEPARATOR);
  const runner = separator === -1 ? argv : argv.slice(0, separator);
  if (runner.includes("-p")) return "seatbelt";
  if (runner[0] === "bwrap") return "bwrap";
  if (runner.includes("--workspace")) return "windows-acl";
  if (runner.includes("--ro") || runner.includes("--rw")) return "landlock";
  return undefined;
}

function sbplString(value: string): string {
  return `"${value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

function sbplRegexBody(source: string): string {
  if (source.includes('"')) {
    throw new Error(
      `sandbox rules: deny pattern ${JSON.stringify(source)} cannot be expressed in a Seatbelt profile`,
    );
  }
  return source;
}

function extendSeatbelt(argv: readonly string[], rules: CompiledRules): string[] {
  const index = argv.indexOf("-p");
  const profile = index === -1 ? undefined : argv[index + 1];
  if (profile === undefined) {
    throw new Error("sandbox rules: the Seatbelt runner argv carries no `-p` profile to extend");
  }
  const additions = [
    ...rules.allowRoots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`),
    ...rules.readOnlySubtrees.map((path) => `(deny file-write* (subpath ${sbplString(path)}))`),
    ...rules.readOnlyPatterns.map(
      (pattern) => `(deny file-write* (regex #"${sbplRegexBody(pattern.source)}"))`,
    ),
    ...rules.denySubtrees.map(
      (path) => `(deny file-read* file-write* (subpath ${sbplString(path)}))`,
    ),
    ...rules.denyPatterns.map(
      (pattern) => `(deny file-read* file-write* (regex #"${sbplRegexBody(pattern.source)}"))`,
    ),
  ];
  const extended = `${profile} ${additions.join(" ")}`;
  return [...argv.slice(0, index + 1), extended, ...argv.slice(index + 2)];
}

function extendBwrap(argv: readonly string[], rules: CompiledRules): string[] {
  const separator = separatorIndex(argv);
  const additions: string[] = [];
  for (const root of rules.allowRoots) additions.push("--bind-try", root, root);
  for (const path of [...rules.readOnlySubtrees, ...rules.denySubtrees]) {
    additions.push("--ro-bind-try", path, path);
  }
  return [...argv.slice(0, separator), ...additions, ...argv.slice(separator)];
}

function extendLandlock(argv: readonly string[], rules: CompiledRules): string[] {
  const separator = separatorIndex(argv);
  const additions = rules.allowRoots.flatMap((root) => ["--rw", root]);
  return [...argv.slice(0, separator), ...additions, ...argv.slice(separator)];
}

export function extendConfinedArgv(argv: readonly string[], rules: CompiledRules): string[] {
  if (isEmptyRules(rules)) return [...argv];
  const dialect = dialectOf(argv);
  if (dialect === undefined) {
    throw new Error(
      "sandbox rules: cannot extend an unrecognized sandbox runner argv; drop allowWrite/deny or configure a bwrap-compatible runnerCommand",
    );
  }
  switch (dialect) {
    case "seatbelt":
      return extendSeatbelt(argv, rules);
    case "bwrap":
      return extendBwrap(argv, rules);
    case "landlock":
      return extendLandlock(argv, rules);
    case "windows-acl":
      return [...argv];
  }
}
