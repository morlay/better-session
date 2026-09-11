#!/usr/bin/env node
/**
 * dsh-desktopify CLI: package and run a dsh workspace as a desktop
 * application. The workspace is the first positional argument (default: the
 * current directory); `DSH_DESKTOP_WORKSPACE` overrides it.
 *
 *   dsh-desktopify dev [--web] [--skip-build] [workspace]
 *                                            launch the Electron shell against
 *                                            the workspace (TS sources loaded
 *                                            directly, no packaging); --web
 *                                            boots `dsh web` in the browser
 *                                            instead
 *   dsh-desktopify bundle [--dir] [--install] [workspace]
 *                                            build a static, unsigned desktop
 *                                            application for the current
 *                                            platform
 *   dsh-desktopify build                     build the shell (tsdown)
 *   dsh-desktopify prepare:runtime [workspace] download and verify the bundled
 *                                            Node.js runtime
 *   dsh-desktopify prepare:seed [workspace]   prepare the packaged profile seed
 * @module @morlay/dsh-desktopify
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { runBundle } from "./bundle.ts";
import { runDev } from "./dev.ts";
import { runPrepareRuntime } from "./prepare-runtime.ts";
import { runPrepareSeed } from "./prepare-seed.ts";
import { buildShell } from "./shell.ts";

/** 工具包根（源码形态 `src/cli` 与构建形态 `dist/cli` 同深度）。 */
const APP_ROOT = resolve(import.meta.dirname, "..", "..");

/** 包版本（读取包根 package.json，源码形态与发布形态一致）。 */
function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}

/** Resolve the workspace argument (default: current directory) and expose it to child processes. */
function resolveWorkspaceArg(workspace: string | undefined): string {
  const resolved = resolve(workspace ?? process.cwd());
  process.env.DSH_DESKTOP_WORKSPACE = resolved;
  return resolved;
}

/** `dev` 命令的旗标。 */
interface DevFlags {
  readonly web?: boolean;
  readonly skipBuild?: boolean;
}

/** `bundle` 命令的旗标。 */
interface BundleFlags {
  readonly dir?: boolean;
  readonly install?: boolean;
}

const program = new Command();

program
  .name("dsh-desktopify")
  .description("package and run a dsh workspace as a desktop application")
  .version(packageVersion());

program
  .command("dev")
  .description("launch the Electron shell against the workspace (or `dsh web` with --web)")
  .option("--web", "boot `dsh web` in the browser instead of the Electron shell")
  .option("--skip-build", "skip rebuilding the shell")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace: string | undefined, options: DevFlags) => {
    await runDev({
      workspace: resolveWorkspaceArg(workspace),
      web: options.web === true,
      skipBuild: options.skipBuild === true,
    });
  });

program
  .command("bundle")
  .description("build a static, unsigned desktop application for the current platform")
  .option("--dir", "produce an unpacked application directory (no installer)")
  .option("--install", "install the built application into the platform application directory")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace: string | undefined, options: BundleFlags) => {
    await runBundle({
      workspace: resolveWorkspaceArg(workspace),
      dir: options.dir === true,
      install: options.install === true,
    });
  });

program.command("build").description("build the shell (tsdown)").action(buildShell);

program
  .command("prepare:runtime")
  .description("download and verify the bundled Node.js runtime")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace: string | undefined) => {
    await runPrepareRuntime({ workspace: resolveWorkspaceArg(workspace) });
  });

program
  .command("prepare:seed")
  .description("prepare the packaged profile seed")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace: string | undefined) => {
    await runPrepareSeed({ workspace: resolveWorkspaceArg(workspace) });
  });

await program.parseAsync(process.argv);
