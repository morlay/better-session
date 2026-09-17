import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import type {
  FsEditOutcome,
  FsEditRequest,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import type { Config } from "./config.ts";
import { writableRoots } from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import { isPathUnder } from "./containment.ts";
import {
  compileRules,
  isDenied,
  isReadOnly,
  ruleSourceOf,
  type CompiledRules,
  type RuleSource,
} from "./rules.ts";

export class ConfigurableFileSystem extends LocalFileSystem {
  static inject = ["sandboxPolicy"];

  private readonly defaultMode: SandboxMode;
  private readonly source: RuleSource;

  private readonly compiled = new Map<string, CompiledRules>();

  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    this.defaultMode = ctx.sandboxPolicy.defaultMode;
    this.source = ruleSourceOf(config, process.env);
  }

  override get sandboxMode(): SandboxMode {
    return this.defaultMode;
  }

  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    const target = await super.resolve(path, opts);
    this.assertNotDenied(
      this.rulesFor(opts?.cwd ?? this.ctx.sandboxPolicy.workspaceRoot),
      target.targetKey,
      target.displayPath,
    );
    return target;
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(
      await this.checkedTarget(target, sandboxPolicy),
      content,
      expected,
      signal,
    );
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
  }

  private assertNotDenied(
    rules: CompiledRules,
    canonicalTarget: string,
    displayPath: string,
  ): void {
    if (!isDenied(rules, canonicalTarget)) return;
    throw new FsError(
      `cannot access "${displayPath}": file access denied by the configured "--" rules`,
      "FS_SANDBOX_DENIED",
    );
  }

  private assertWritable(rules: CompiledRules, canonicalTarget: string, displayPath: string): void {
    this.assertNotDenied(rules, canonicalTarget, displayPath);
    if (!isReadOnly(rules, canonicalTarget)) return;
    throw new FsError(
      `cannot write "${displayPath}": path is read-only by the configured "r-" rule`,
      "FS_SANDBOX_DENIED",
    );
  }

  private async checkedTarget(
    target: FsTarget,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
    const rules = this.rulesFor(policy.workspaceRoot);
    this.assertWritable(rules, target.targetKey, target.displayPath);
    const { mode } = policy;
    if (mode === "danger-full-access") return target;
    if (mode === "read-only") {
      throw new FsError(
        `cannot write "${target.displayPath}": file access denied under read-only mode`,
        "FS_SANDBOX_DENIED",
      );
    }

    const fresh = await super.resolve(target.displayPath);
    this.assertWritable(rules, fresh.targetKey, fresh.displayPath);
    for (const root of [...writableRoots(policy), ...rules.allowRoots]) {
      if (await isPathUnder(fresh.targetKey, root)) return fresh;
    }
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
      "FS_SANDBOX_DENIED",
    );
  }

  private rulesFor(workspaceRoot: string): CompiledRules {
    const cached = this.compiled.get(workspaceRoot);
    if (cached !== undefined) return cached;
    const compiled = compileRules(this.source, workspaceRoot);
    this.compiled.set(workspaceRoot, compiled);
    return compiled;
  }
}

export default ConfigurableFileSystem;
