/**
 * 进程沙箱 provider：继承官方 `@deepseek-ai/dsh-sandbox-local` 的实现（runner 探测与
 * 选择、Windows ACL 的私有 temp 流程、拒绝方言与 runner 失败规则全部保留），
 * 只在 `confine` 产出的 argv 上追加本包的 `access` 条目（`rw` / `r-` / `--`）。
 *
 * 服务键沿用上游基类的 `ctx.sandbox`；装配时官方 `sandbox` 行必须被禁用，
 * 否则同名服务会 fail loud。
 * @module @morlay/dsh-sandbox-local/sandbox
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ConfinedArgv, SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import type { Config } from "./config.ts";
import { extendConfinedArgv } from "./dialects.ts";
import {
  compileRules,
  isEmptyRules,
  ruleSourceOf,
  withoutAllowRoots,
  type CompiledRules,
  type RuleSource,
} from "./rules.ts";

/**
 * 官方本机沙箱 provider 的可配置版本。
 * `read-only` 模式不追加 `rw` 条目（只读边界不因额外可写根放松）；`--` 条目在两种
 * confined 模式下都生效。
 */
export class ConfigurableSandboxProvider extends LocalSandboxProvider {
  private readonly source: RuleSource;
  /** 规则按工作区根编译一次（相对规则相对该调用的工作区）。 */
  private readonly compiled = new Map<string, CompiledRules>();

  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    this.source = ruleSourceOf(config, process.env);
  }

  /**
   * 官方拼装 + 规则追加。
   * @param argv - 调用方即将 spawn 的 argv。
   * @param policy - 本次调用的文件效果策略。
   * @returns 追加规则后的 confined argv（空规则时与官方结果一致）。
   */
  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const confined = super.confine(argv, policy);
    const rules = this.rulesFor(policy.workspaceRoot);
    const effective = policy.mode === "workspace-write" ? rules : withoutAllowRoots(rules);
    if (isEmptyRules(effective)) return confined;
    return { ...confined, argv: extendConfinedArgv(confined.argv, effective) };
  }

  /** 取（并按需编译缓存）某个工作区根下的规则。 */
  private rulesFor(workspaceRoot: string): CompiledRules {
    const cached = this.compiled.get(workspaceRoot);
    if (cached !== undefined) return cached;
    const compiled = compileRules(this.source, workspaceRoot);
    this.compiled.set(workspaceRoot, compiled);
    return compiled;
  }
}

export default ConfigurableSandboxProvider;
