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
 *   dsh-desktopify bundle [--dir] [workspace] build a static, unsigned desktop
 *                                            application for the current
 *                                            platform
 *   dsh-desktopify build                      build the shell (tsdown)
 *   dsh-desktopify prepare:runtime [workspace] download and verify the bundled
 *                                            Node.js runtime
 *   dsh-desktopify prepare:seed [workspace]   prepare the packaged profile seed
 */

import { Command } from "commander";
import { resolve } from "node:path";
import { runBundle } from "../src/cli/bundle.ts";
import { runDev } from "../src/cli/dev.ts";
import { runPrepareRuntime } from "../src/cli/prepare-runtime.ts";
import { runPrepareSeed } from "../src/cli/prepare-seed.ts";

const program = new Command();

/** Resolve the workspace argument (default: current directory) and expose it to child processes. */
function resolveWorkspaceArg(workspace) {
  const resolved = resolve(workspace ?? process.cwd());
  process.env.DSH_DESKTOP_WORKSPACE = resolved;
  return resolved;
}

program
  .name("dsh-desktopify")
  .description("package and run a dsh workspace as a desktop application")
  .version("0.1.0");

program
  .command("dev")
  .description("launch the Electron shell against the workspace (or `dsh web` with --web)")
  .option("--web", "boot `dsh web` in the browser instead of the Electron shell")
  .option("--skip-build", "skip rebuilding the shell")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace, options) => {
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
  .action(async (workspace, options) => {
    await runBundle({
      workspace: resolveWorkspaceArg(workspace),
      dir: options.dir === true,
      install: options.install === true,
    });
  });

program
  .command("build")
  .description("build the shell (tsdown)")
  .action(async () => {
    const { spawn } = await import("node:child_process");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const toolRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    await new Promise((resolvePromise, reject) => {
      const child = spawn("pnpm", ["run", "build"], { cwd: toolRoot, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`dsh-desktopify: build exited with ${String(code)}`));
      });
    });
  });

program
  .command("prepare:runtime")
  .description("download and verify the bundled Node.js runtime")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace) => {
    await runPrepareRuntime({ workspace: resolveWorkspaceArg(workspace) });
  });

program
  .command("prepare:seed")
  .description("prepare the packaged profile seed")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace) => {
    await runPrepareSeed({ workspace: resolveWorkspaceArg(workspace) });
  });

await program.parseAsync(process.argv);
