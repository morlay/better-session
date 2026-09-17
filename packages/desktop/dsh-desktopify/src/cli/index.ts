#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { runBundle } from "./bundle.ts";
import { runDev } from "./dev.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(APP_ROOT, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}

function resolveWorkspaceArg(workspace: string | undefined): string {
  const resolved = resolve(workspace ?? process.cwd());
  process.env.DSH_DESKTOP_WORKSPACE = resolved;
  return resolved;
}

interface DevFlags {
  readonly web?: boolean;
}

interface BundleFlags {
  readonly dir?: boolean;
  readonly install?: boolean;
}

const program = new Command();

program
  .name("dsh-desktopify")
  .description("package and run a dsh workspace as a desktop application")
  .version(await packageVersion());

program
  .command("dev")
  .description("launch the Electron shell against the workspace (or `dsh web` with --web)")
  .option("--web", "boot `dsh web` in the browser instead of the Electron shell")
  .argument("[workspace]", "app workspace directory (default: current directory)")
  .action(async (workspace: string | undefined, options: DevFlags) => {
    await runDev({
      workspace: resolveWorkspaceArg(workspace),
      web: options.web === true,
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

await program.parseAsync(process.argv);
