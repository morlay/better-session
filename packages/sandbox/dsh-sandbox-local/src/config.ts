import z from "@deepseek-ai/schemastery";
import type { Config as UpstreamFsConfig } from "@deepseek-ai/dsh-fs-local";
import type { Config as UpstreamSandboxConfig } from "@deepseek-ai/dsh-sandbox-local";

export interface Config extends UpstreamSandboxConfig, UpstreamFsConfig {
  access?: string | string[];
}

export const Config: z<Config> = z.object({
  access: z.union([z.array(z.string()), z.string()]).default([]),
  runnerCommand: z.array(z.string()).default([]),
  runnerFailureSignatures: z.array(z.string()).default([]),
  probeTimeoutMs: z.natural().default(5_000),
  cwd: z.string().default(process.cwd()),
  diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
});
