/**
 * 在官方 provider 生成的 confined argv 上追加本包规则：
 * Seatbelt 追加 SBPL 规则（后置规则覆盖先前的 allow，实测 `(deny file-read* file-write*
 * (subpath …))` 能压过 `(allow file-write* (subpath …))`，`r-` 条目则只 deny 写入），
 * bwrap 追加挂载参数（`rw` 用 `--bind-try`，`r-` 与 `--` 都用 `--ro-bind-try`），
 * Landlock 只能追加可写授权（其 allow-list 语义无法减除子路径），
 * Windows ACL runner 没有对应表达。
 *
 * 方言从官方 `ConfinedArgv.argv` 的结构识别：runner 参数在前，`--` 之后是调用方 argv。
 * @module @morlay/dsh-sandbox-local/dialects
 */

import { isEmptyRules, type CompiledRules } from "./rules.ts";

/** 官方 provider 可选的执行方言。 */
export type SandboxDialect = "seatbelt" | "bwrap" | "landlock" | "windows-acl";

/** runner 部分与调用方 argv 的分隔符。 */
const SEPARATOR = "--";

/**
 * 一个方言能表达的规则能力。
 * `readOnly` 指 `r-` 条目（只拒写入）；`denyWriteOnly` 指 `--` 条目在该方言上只能
 * 退化为“只拒写入”（读取仍放行）。
 */
export interface DialectCapabilities {
  /** 能否把额外可写根写进 runner 参数。 */
  readonly allowWrite: boolean;
  /** 能否表达 `r-`（只拒写入）。 */
  readonly readOnly: boolean;
  /** 能否表达 `--` 的完整语义（读与写都拒）。 */
  readonly denyReadWrite: boolean;
  /** `--` 是否只能退化为拒绝写入。 */
  readonly denyWriteOnly: boolean;
}

/** 各方言的规则表达能力——加载期据此告警，运行期据此决定是否改写参数。 */
export const DIALECT_CAPABILITIES: Record<SandboxDialect, DialectCapabilities> = {
  seatbelt: { allowWrite: true, readOnly: true, denyReadWrite: true, denyWriteOnly: false },
  bwrap: { allowWrite: true, readOnly: true, denyReadWrite: false, denyWriteOnly: true },
  landlock: { allowWrite: true, readOnly: false, denyReadWrite: false, denyWriteOnly: false },
  "windows-acl": { allowWrite: false, readOnly: false, denyReadWrite: false, denyWriteOnly: false },
};

/** runner 部分的结束位置。 */
function separatorIndex(argv: readonly string[]): number {
  const index = argv.indexOf(SEPARATOR);
  if (index === -1) {
    throw new Error("sandbox rules: the confined argv carries no `--` separator to extend");
  }
  return index;
}

/**
 * 识别 argv 使用的执行方言。
 * @param argv - 官方 provider 返回的完整 confined argv。
 * @returns 方言，或无法识别时的 `undefined`（例如运维自定义的 runnerCommand）。
 */
export function dialectOf(argv: readonly string[]): SandboxDialect | undefined {
  const separator = argv.indexOf(SEPARATOR);
  const runner = separator === -1 ? argv : argv.slice(0, separator);
  if (runner.includes("-p")) return "seatbelt";
  if (runner[0] === "bwrap") return "bwrap";
  if (runner.includes("--workspace")) return "windows-acl";
  if (runner.includes("--ro") || runner.includes("--rw")) return "landlock";
  return undefined;
}

/** SBPL 字符串字面量。 */
function sbplString(value: string): string {
  return `"${value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/**
 * SBPL `#"…"` 的正则体：正则自身的 `\` 必须保留（glob 翻译用它转义元字符），
 * 因此拒绝项里出现双引号时直接报错，而不是产出一个含义变化的 profile。
 */
function sbplRegexBody(source: string): string {
  if (source.includes('"')) {
    throw new Error(
      `sandbox rules: deny pattern ${JSON.stringify(source)} cannot be expressed in a Seatbelt profile`,
    );
  }
  return source;
}

/** Seatbelt：把 allow / deny 规则追加到 `-p` 的 profile 文本末尾。 */
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

/**
 * bwrap：额外可写根用 `--bind-try`（路径不存在时跳过）；`r-` 与 `--` 都用
 * `--ro-bind-try` 覆盖成只读（挂载后行覆盖前行）——也就是说 `--` 在 bwrap 上退化为
 * “只拒写入”。glob 模式无法表达为静态挂载，由调用方在加载期告警。
 */
function extendBwrap(argv: readonly string[], rules: CompiledRules): string[] {
  const separator = separatorIndex(argv);
  const additions: string[] = [];
  for (const root of rules.allowRoots) additions.push("--bind-try", root, root);
  for (const path of [...rules.readOnlySubtrees, ...rules.denySubtrees]) {
    additions.push("--ro-bind-try", path, path);
  }
  return [...argv.slice(0, separator), ...additions, ...argv.slice(separator)];
}

/** Landlock：只能追加可写授权（`--rw`），`r-` 与 `--` 都无对应表达。 */
function extendLandlock(argv: readonly string[], rules: CompiledRules): string[] {
  const separator = separatorIndex(argv);
  const additions = rules.allowRoots.flatMap((root) => ["--rw", root]);
  return [...argv.slice(0, separator), ...additions, ...argv.slice(separator)];
}

/**
 * 按 argv 的方言追加规则。
 * @param argv - 官方 provider 返回的 confined argv。
 * @param rules - 已编译规则；空规则原样返回。
 * @returns 追加规则后的 argv；方言无法识别时抛错（规则不能静默失效）。
 */
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
      // windows-acl 的 runner 参数没有承载额外 grant 的入口：加载期已告警，这里保持原 argv。
      return [...argv];
  }
}
