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

export class ConfigurableSandboxProvider extends LocalSandboxProvider {
  private readonly source: RuleSource;

  private readonly compiled = new Map<string, CompiledRules>();

  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    this.source = ruleSourceOf(config, process.env);
  }

  override async confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    const confined = await super.confine(argv, policy, signal);
    const rules = this.rulesFor(policy.workspaceRoot);
    const effective = policy.mode === "workspace-write" ? rules : withoutAllowRoots(rules);
    if (isEmptyRules(effective)) return confined;
    return { ...confined, argv: extendConfinedArgv(confined.argv, effective) };
  }

  private rulesFor(workspaceRoot: string): CompiledRules {
    const cached = this.compiled.get(workspaceRoot);
    if (cached !== undefined) return cached;
    const compiled = compileRules(this.source, workspaceRoot);
    this.compiled.set(workspaceRoot, compiled);
    return compiled;
  }
}

export default ConfigurableSandboxProvider;
