/**
 * 规则编译：`access` 条目解析（`rw <path>` 额外可写根 / `r- <path>` 只读 /
 * `-- <pattern>` 拒绝访问）、`{{ env.NAME }}` 模板展开、相对工作区路径的绝对化、
 * glob → 正则，以及编译结果的匹配。
 *
 * 命中优先级：`--` 拒绝覆盖一切；`r-` 只读覆盖可写授予；都未命中时才按可写根判定。
 *
 * 生成的正则源码同时交给进程内检查（JS `RegExp`）与 macOS Seatbelt profile
 * （SBPL 的 `(regex #"…")`），因此只用 POSIX ERE 与 JS 正则共有的语法。
 * @module @morlay/dsh-sandbox-local/rules
 */

import { isAbsolute, resolve, sep } from "node:path";
import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";

/** `{{ env.NAME }}` 模板；名字限定为环境变量的字符集。 */
const ENV_TEMPLATE = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** `access` 的条目形式：`rw <path>` / `r- <path>` / `-- <pattern>`；前缀后必须有空白。 */
const ACCESS_LINE = /^(rw|r-|--)(?:\s+(.*))?$/u;

/** glob 元字符：规则里出现即按模式匹配，否则按字面路径（含其全部后代）匹配。 */
const GLOB_META = /[*?[]/;

/** glob 翻译时需要转义的正则元字符（字符类内部除外）。 */
const REGEX_META = /[\\^$+.(){}|]/;

/** 展开规则里的 `{{ env.NAME }}`；引用未定义或为空的环境变量直接抛错。 */
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

/**
 * 把含 glob 的规则翻译成正则源码。
 * `**` 跨目录层级（`**` 与“`**` 后接斜杠”都能匹配零层），`*` 与 `?` 不跨 `/`，
 * 字符类透传（`[!…]` 按 glob 习惯翻成 `[^…]`），其余正则元字符转义。
 * @param pattern - 已绝对化的 glob 规则。
 * @returns 可同时被 JS `RegExp` 与 SBPL regex 接受的正则源码。
 */
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

/** 规则来源：模板已在加载期展开，路径仍是相对/绝对的原始拼写。 */
export interface RuleSource {
  /** `rw` 条目：额外可写根。 */
  readonly allowWrite: readonly string[];
  /** `r-` 条目：只读（读放行、写拒绝）。 */
  readonly readOnly: readonly string[];
  /** `--` 条目：拒绝访问（读 + 写）。 */
  readonly deny: readonly string[];
}

/** 一条已编译的模式：源码同时供 JS `RegExp` 与 SBPL regex 使用。 */
export interface CompiledPattern {
  /** 正则源码。 */
  readonly source: string;
  /** 进程内检查用的已编译正则。 */
  readonly regex: RegExp;
}

/** 编译后的规则：按一个工作区根绝对化后的可写根、只读项与拒绝项。 */
export interface CompiledRules {
  /** 额外可写根（canonical 绝对路径）。 */
  readonly allowRoots: readonly string[];
  /** 只读的字面路径（canonical）：命中自身及其全部后代。 */
  readonly readOnlySubtrees: readonly string[];
  /** 只读的模式。 */
  readonly readOnlyPatterns: readonly CompiledPattern[];
  /** 拒绝访问的字面路径（canonical）：命中自身及其全部后代。 */
  readonly denySubtrees: readonly string[];
  /** 拒绝访问的模式。 */
  readonly denyPatterns: readonly CompiledPattern[];
}

/** 规则是否为空——空规则下 provider 不改写任何 runner 参数。 */
export function isEmptyRules(rules: CompiledRules): boolean {
  return (
    rules.allowRoots.length === 0 &&
    rules.readOnlySubtrees.length === 0 &&
    rules.readOnlyPatterns.length === 0 &&
    rules.denySubtrees.length === 0 &&
    rules.denyPatterns.length === 0
  );
}

/** 只读模式不因 `rw` 条目放松：投影出只保留 `r-` / `--` 条目的规则集。 */
export function withoutAllowRoots(rules: CompiledRules): CompiledRules {
  return rules.allowRoots.length === 0 ? rules : { ...rules, allowRoots: [] };
}

/**
 * 解析 `access` 配置：接受字符串数组（每项一条规则）或多行文本（每行一条规则），
 * 空行忽略；`rw <path>` 是额外可写根，`r- <path>` 是只读，`-- <pattern>` 是访问
 * 拒绝（读 + 写）。缺前缀或前缀后没有路径都直接报错——规则不因写法歧义而变形。
 * @param input - 配置里的 `access` 值。
 * @returns `allowWrite` / `readOnly` / `deny` 三组规则（模板尚未展开）。
 */
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

/**
 * 把配置里的 `access` 转成规则来源：模板在这一步展开（加载期，fail-fast），
 * 相对路径留待按调用时的工作区根绝对化。
 * @param config - 含 `access` 的插件配置。
 * @param env - 模板展开用的进程环境。
 * @returns 模板已展开的规则来源。
 */
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

/** 绝对化一条规则：相对路径相对工作区根。 */
function absolutize(value: string, workspaceRoot: string): string {
  return isAbsolute(value) ? value : resolve(workspaceRoot, value);
}

/** 编译一组字面路径 / glob 规则：字面项按子树（含全部后代）匹配，glob 项按整串匹配。 */
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

/**
 * 按一个工作区根编译规则。
 * `rw` 条目必须是具体路径（glob 无法表达“可写根”）；`r-` 与 `--` 条目允许 glob。
 * @param source - 已展开模板的规则来源。
 * @param workspaceRoot - 相对规则解析用的工作区根（canonical 绝对路径）。
 * @returns 编译后的规则。
 */
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

/**
 * 一次调用可写入的根集合：官方 `writableRoots` 加上 `rw` 条目；`read-only` 不追加
 * （额外可写根不放松显式选定的只读边界）。
 * @param rules - 已编译规则。
 * @param policy - per-call 策略。
 * @returns canonical 可写根列表。
 */
export function writableRootsWith(
  rules: CompiledRules,
  policy: SandboxExecutionPolicy,
): readonly string[] {
  const roots = writableRoots(policy);
  return policy.mode === "workspace-write" ? [...roots, ...rules.allowRoots] : roots;
}

/** 字面规则的后代判定（canonical 拼写，与 Seatbelt `subpath` 同一语义）。 */
function isUnder(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** 命中任一子树或任一模式。 */
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

/**
 * 判断目标是否被 `--` 条目命中（读与写都拒）。
 * @param rules - 已编译规则。
 * @param canonicalTarget - 目标的 canonical 路径。
 * @returns 命中即 true。
 */
export function isDenied(rules: CompiledRules, canonicalTarget: string): boolean {
  return matches(canonicalTarget, rules.denySubtrees, rules.denyPatterns);
}

/**
 * 判断目标是否被 `r-` 条目命中（读放行、写拒绝）。
 * @param rules - 已编译规则。
 * @param canonicalTarget - 目标的 canonical 路径。
 * @returns 命中即 true。
 */
export function isReadOnly(rules: CompiledRules, canonicalTarget: string): boolean {
  return matches(canonicalTarget, rules.readOnlySubtrees, rules.readOnlyPatterns);
}

/**
 * 判断目标是否不可写：`--` 与 `r-` 条目都拒绝写入，且优先于任何可写根。
 * @param rules - 已编译规则。
 * @param canonicalTarget - 目标的 canonical 路径。
 * @returns 命中即 true。
 */
export function blocksWrite(rules: CompiledRules, canonicalTarget: string): boolean {
  return isDenied(rules, canonicalTarget) || isReadOnly(rules, canonicalTarget);
}
