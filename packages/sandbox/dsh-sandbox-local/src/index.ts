/**
 * 可配置沙箱插件：替换官方进程沙箱 provider（`ctx.sandbox`）与文件系统后端（`ctx.fs`），
 * 在官方语义之上叠加 `access` 规则。
 *
 * 每条规则以 `rw ` / `r- ` / `-- ` 开头：`rw <path>` 是工作区与平台临时目录之外的额外
 * 可写根，`r- <path>` 是只读（读放行、写拒绝），`-- <pattern>` 是访问拒绝（读 + 写）。
 * 三条都支持 `{{ env.NAME }}`（加载期展开，引用未定义的环境变量直接失败）与相对工作区的
 * 路径；命中优先级是 `--` > `r-` > 可写根。`ctx.fs` 侧语义完整，`ctx.sandbox` 侧在能表达
 * 该语义的方言上生效（见 {@link DIALECT_CAPABILITIES}）。
 *
 * 装配前提：官方 `sandbox` 与 `fs-sandbox` 行必须被禁用（包内 `cordis.patch.yml` 或
 * 部署层 patch），否则同名服务 fail loud；规则由部署层在插入本行时写死
 * （本部署见 `@morlay/dsh-preset`），包内不预设。
 * @module @morlay/dsh-sandbox-local
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Config } from "./config.ts";
import { DIALECT_CAPABILITIES } from "./dialects.ts";
import { ConfigurableFileSystem } from "./fs.ts";
import { ruleSourceOf } from "./rules.ts";
import { ConfigurableSandboxProvider } from "./sandbox.ts";

// 值与类型一起转出：Loader 读 `Config`（schema），消费方读类型。
export { Config } from "./config.ts";

/** Cordis 插件名。 */
export const name = "sandbox-local";

/** fs 侧从策略服务取默认模式与工作区回退根，所以先等 `ctx.sandboxPolicy`。 */
export const inject = ["sandboxPolicy"];

/**
 * 规则在进程沙箱侧的能力随平台方言变化，加载期把降级说清楚：
 * `ctx.fs` 侧（read / write / edit 工具）在 macOS / Linux / Windows 上语义一致，
 * 只有 bash 等子进程走平台 runner 的表达能力。
 */
function warnAboutDegradedRules(ctx: Context, config: Config): void {
  const rules = ruleSourceOf(config, process.env);
  const grants = rules.allowWrite.length > 0;
  const readOnly = rules.readOnly.length > 0;
  const denials = rules.deny.length > 0;
  if (!grants && !readOnly && !denials) return;
  if (process.platform === "darwin") return;
  if (readOnly || denials) {
    const seatbelt = DIALECT_CAPABILITIES.seatbelt.denyReadWrite;
    const bwrap = DIALECT_CAPABILITIES.bwrap.denyWriteOnly;
    ctx.logger.warn(
      `sandbox-local: "r-" / "--" entries cannot be fully enforced for confined subprocesses on ${process.platform} ` +
        `(Seatbelt enforces both; bwrap binds the path read-only, so "--" degrades to write-only: ${bwrap}; ` +
        `Landlock and the Windows ACL runner cannot express a subpath rule at all: ${seatbelt} applies to Seatbelt only) ` +
        "— tools that read through ctx.fs stay covered",
    );
  }
  if (grants && process.platform === "win32") {
    ctx.logger.warn(
      'sandbox-local: "rw" entries cannot be granted to confined subprocesses on win32; ' +
        "ctx.fs covers the extra roots, the Windows ACL runner does not",
    );
  }
}

/**
 * 注册两个替换实现。
 * @param ctx - 插件上下文（官方 `sandbox` / `fs-sandbox` 行已禁用）。
 * @param config - 已由 schema 填好默认值的配置。
 */
export function apply(ctx: Context, config: Config): void {
  warnAboutDegradedRules(ctx, config);
  new ConfigurableSandboxProvider(ctx, config);
  new ConfigurableFileSystem(ctx, config);
}
