/**
 * 插件配置的单一真源：`access` 规则 + 透传官方的字段。
 *
 * 规则只在这里声明一次——provider 与 fs 后端按构造参数接收已解析的配置，
 * 不各自重复声明 schema；部署层的规则值随插入本行的 patch 写死（本部署见
 * `@morlay/dsh-preset`），包内不预设。
 * @module @morlay/dsh-sandbox-local/config
 */

import z from "@deepseek-ai/schemastery";
import type { Config as UpstreamFsConfig } from "@deepseek-ai/dsh-fs-local";
import type { Config as UpstreamSandboxConfig } from "@deepseek-ai/dsh-sandbox-local";

/** 插件配置。 */
export interface Config extends UpstreamSandboxConfig, UpstreamFsConfig {
  /**
   * 规则条目：`rw <path>`（额外可写根）、`r- <path>`（只读）、`-- <pattern>`（拒绝访问）。
   * 数组每项一条，或写一段多行文本（每行一条）；`{{ env.NAME }}` 按进程环境展开。
   */
  access?: string | string[];
}

/** 运行时配置 schema。 */
export const Config: z<Config> = z.object({
  access: z.union([z.array(z.string()), z.string()]).default([]),
  runnerCommand: z.array(z.string()).default([]),
  runnerFailureSignatures: z.array(z.string()).default([]),
  probeTimeoutMs: z.natural().default(5_000),
  cwd: z.string().default(process.cwd()),
  diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
});
