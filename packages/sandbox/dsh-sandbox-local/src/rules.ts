import { isAbsolute, resolve, sep } from "node:path";
import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";

const ENV_TEMPLATE = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const ACCESS_LINE = /^(rw|r-|--)(?:\s+(.*))?$/u;

const GLOB_META = /[*?[]/;

const REGEX_META = /[\\^$+.(){}|]/;

export function expandEnvTemplates(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_TEMPLATE, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved.length === 0) {
      throw new Error(
        `sandbox rules: "${value}" references the unset environment variable "${name}"`,
      );
    }
    return resolved;
  });
}

export function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      const body = pattern.slice(index + 1, close);
      if (body.length === 0) {
        source += "\\[\\]";
        index = close;
        continue;
      }
      source += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
      index = close;
      continue;
    }
    source += REGEX_META.test(char) ? `\\${char}` : char;
  }
  return source;
}

export interface RuleSource {
  readonly allowWrite: readonly string[];

  readonly readOnly: readonly string[];

  readonly deny: readonly string[];
}

export interface CompiledPattern {
  readonly source: string;

  readonly regex: RegExp;
}

export interface CompiledRules {
  readonly allowRoots: readonly string[];

  readonly readOnlySubtrees: readonly string[];

  readonly readOnlyPatterns: readonly CompiledPattern[];

  readonly denySubtrees: readonly string[];

  readonly denyPatterns: readonly CompiledPattern[];
}

export function isEmptyRules(rules: CompiledRules): boolean {
  return (
    rules.allowRoots.length === 0 &&
    rules.readOnlySubtrees.length === 0 &&
    rules.readOnlyPatterns.length === 0 &&
    rules.denySubtrees.length === 0 &&
    rules.denyPatterns.length === 0
  );
}

export function withoutAllowRoots(rules: CompiledRules): CompiledRules {
  return rules.allowRoots.length === 0 ? rules : { ...rules, allowRoots: [] };
}

export function parseAccess(input: string | readonly string[] | undefined): RuleSource {
  const lines = (input === undefined ? [] : typeof input === "string" ? [input] : [...input])
    .flatMap((value) => value.split(/\r?\n/u))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const allowWrite: string[] = [];
  const readOnly: string[] = [];
  const deny: string[] = [];
  for (const line of lines) {
    const match = ACCESS_LINE.exec(line);
    if (match === null) {
      throw new Error(
        `sandbox rules: access entry ${JSON.stringify(line)} must start with "rw " (write), "r- " (read-only) or "-- " (deny)`,
      );
    }
    const rule = (match[2] ?? "").trim();
    if (rule.length === 0) {
      throw new Error(`sandbox rules: access entry ${JSON.stringify(line)} carries no path`);
    }
    if (match[1] === "rw") allowWrite.push(rule);
    else if (match[1] === "r-") readOnly.push(rule);
    else deny.push(rule);
  }
  return { allowWrite, readOnly, deny };
}

export function ruleSourceOf(
  config: { access?: string | readonly string[] },
  env: NodeJS.ProcessEnv,
): RuleSource {
  const parsed = parseAccess(config.access);
  const expand = (values: readonly string[]): string[] =>
    values.map((value) => expandEnvTemplates(value, env));
  return {
    allowWrite: expand(parsed.allowWrite),
    readOnly: expand(parsed.readOnly),
    deny: expand(parsed.deny),
  };
}

function absolutize(value: string, workspaceRoot: string): string {
  return isAbsolute(value) ? value : resolve(workspaceRoot, value);
}

function compilePaths(
  values: readonly string[],
  workspaceRoot: string,
): { subtrees: string[]; patterns: CompiledPattern[] } {
  const subtrees: string[] = [];
  const patterns: CompiledPattern[] = [];
  for (const value of values) {
    const absolute = absolutize(value, workspaceRoot);
    if (GLOB_META.test(value)) {
      const pattern = `^${globToRegexSource(absolute)}$`;
      patterns.push({ source: pattern, regex: new RegExp(pattern) });
    } else {
      subtrees.push(canonicalPath(absolute));
    }
  }
  return { subtrees, patterns };
}

export function compileRules(source: RuleSource, workspaceRoot: string): CompiledRules {
  const allowRoots: string[] = [];
  for (const value of source.allowWrite) {
    if (GLOB_META.test(value)) {
      throw new Error(`sandbox rules: rw entry "${value}" must name a concrete path, not a glob`);
    }
    allowRoots.push(canonicalPath(absolutize(value, workspaceRoot)));
  }
  const readOnly = compilePaths(source.readOnly, workspaceRoot);
  const deny = compilePaths(source.deny, workspaceRoot);
  return {
    allowRoots,
    readOnlySubtrees: readOnly.subtrees,
    readOnlyPatterns: readOnly.patterns,
    denySubtrees: deny.subtrees,
    denyPatterns: deny.patterns,
  };
}

export function writableRootsWith(
  rules: CompiledRules,
  policy: SandboxExecutionPolicy,
): readonly string[] {
  const roots = writableRoots(policy);
  return policy.mode === "workspace-write" ? [...roots, ...rules.allowRoots] : roots;
}

function isUnder(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function matches(
  canonicalTarget: string,
  subtrees: readonly string[],
  patterns: readonly CompiledPattern[],
): boolean {
  for (const subtree of subtrees) {
    if (isUnder(canonicalTarget, subtree)) return true;
  }
  return patterns.some((pattern) => pattern.regex.test(canonicalTarget));
}

export function isDenied(rules: CompiledRules, canonicalTarget: string): boolean {
  return matches(canonicalTarget, rules.denySubtrees, rules.denyPatterns);
}

export function isReadOnly(rules: CompiledRules, canonicalTarget: string): boolean {
  return matches(canonicalTarget, rules.readOnlySubtrees, rules.readOnlyPatterns);
}

export function blocksWrite(rules: CompiledRules, canonicalTarget: string): boolean {
  return isDenied(rules, canonicalTarget) || isReadOnly(rules, canonicalTarget);
}
