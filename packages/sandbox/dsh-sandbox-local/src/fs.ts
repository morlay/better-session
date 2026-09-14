/**
 * 文件系统围栏：继承官方 `@deepseek-ai/dsh-fs-local` 的文本存储机制
 * （resolve / stat / 读流 / 原子写 / read-match-write 编辑），在访问入口叠加规则：
 * `--` 命中即拒绝访问（读与写都拒，任何模式下都生效），`r-` 只拒写入，`rw` 参与
 * `workspace-write` 的可写判定（官方 `writableRoots` 之外的额外可写根）。
 *
 * 与它替换掉的官方 `@deepseek-ai/dsh-fs-sandbox` 一样，这是受信代码里的策略检查，
 * 不是内核边界：内核级隔离仍由 `ctx.sandbox` 侧负责。
 * @module @morlay/dsh-sandbox-local/fs
 */

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

/**
 * 官方本机文件系统后端的可配置版本。
 * `--` 条目在解析阶段拒绝目标（覆盖 read / write / edit / list 等一切工具入口），
 * `r-` 与 `--` 条目在写入前拒绝写入（优先于任何可写根），写操作再按
 * `workspace-write` + `rw` 条目复核 containment。
 */
export class ConfigurableFileSystem extends LocalFileSystem {
  static inject = ["sandboxPolicy"];

  private readonly defaultMode: SandboxMode;
  private readonly source: RuleSource;
  /** 规则按工作区根编译一次（相对规则相对该调用的工作区）。 */
  private readonly compiled = new Map<string, CompiledRules>();

  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    this.defaultMode = ctx.sandboxPolicy.defaultMode;
    this.source = ruleSourceOf(config, process.env);
  }

  /** 工具层读它判断后端是否 confine（并据此广告 escalation 字段）。 */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode;
  }

  /**
   * 解析目标后立即执行拒绝判定：工具入口（read / write / edit / list）都先经过
   * `resolve`，因此一次判定即可覆盖读与写。
   * @param path - 待解析的路径。
   * @param opts - cwd 与取消信号；cwd 同时是相对规则的解析根。
   * @returns 解析后的目标。
   */
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

  /**
   * 按 per-call 策略复核后写入。
   * @param target - 工具解析出的目标。
   * @param content - 新的完整内容。
   * @param expected - 写入前版本守卫。
   * @param signal - 取消信号。
   * @param sandboxPolicy - per-call 策略；省略时用部署默认。
   * @returns 上游写入结果。
   */
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

  /**
   * 按 per-call 策略复核后编辑。
   * @param target - 工具解析出的目标。
   * @param edit - 字面量 search/replace 请求。
   * @param expected - 版本守卫。
   * @param signal - 取消信号。
   * @param sandboxPolicy - per-call 策略；省略时用部署默认。
   * @returns 上游编辑结果。
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
  }

  /** `--` 条目命中即拒绝访问（读与写都拒）；抛 `FS_SANDBOX_DENIED`。 */
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

  /** `--` 或 `r-` 条目命中即拒绝写入，且优先于任何可写根。 */
  private assertWritable(rules: CompiledRules, canonicalTarget: string, displayPath: string): void {
    this.assertNotDenied(rules, canonicalTarget, displayPath);
    if (!isReadOnly(rules, canonicalTarget)) return;
    throw new FsError(
      `cannot write "${displayPath}": path is read-only by the configured "r-" rule`,
      "FS_SANDBOX_DENIED",
    );
  }

  /**
   * 写前复核：`--` / `r-` 条目（任何模式）→ 模式本身的只读拒绝 → `workspace-write` 的
   * `writableRoots + rw` containment，返回必须被写入的那个目标。
   */
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
    // workspace-write：在新鲜解析出的 canonical 目标上复核，写入也用它（避免
    // “检查这里、写那里”的 TOCTOU 窗口）。
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

  /** 取（并按需编译缓存）某个工作区根下的规则。 */
  private rulesFor(workspaceRoot: string): CompiledRules {
    const cached = this.compiled.get(workspaceRoot);
    if (cached !== undefined) return cached;
    const compiled = compileRules(this.source, workspaceRoot);
    this.compiled.set(workspaceRoot, compiled);
    return compiled;
  }
}

export default ConfigurableFileSystem;
