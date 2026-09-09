/**
 * Unix backend launch with user-shell environment injection: when the user's
 * `$SHELL` has a matching rc file (`~/.bashrc` for bash, `~/.zshrc` for zsh),
 * the backend command is spawned through `$SHELL -c 'source <rc> >/dev/null
 * 2>&1; exec <command> <args...>'` so the backend inherits the user's terminal
 * environment (API keys and other exports). `exec` keeps the same process, so
 * the supervisor's wait and process-group semantics are unaffected; the source
 * output is discarded so it never pollutes the backend's stdout. The child is
 * detached into its own process group so the shell can terminate the whole
 * backend tree on exit. Windows spawns directly.
 * @module @morlay/dsh-custom-desktop
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { basename } from "node:path";

/** rc file to source for one shell basename; empty means no injection. */
export function rcFileFor(shell: string): string {
  switch (basename(shell)) {
    case "bash":
      return "~/.bashrc";
    case "zsh":
      return "~/.zshrc";
    default:
      return "";
  }
}

/** Single-quote a string for shell command lines (paths may contain spaces). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Spawn a backend command through the user shell with rc sourcing on Unix,
 * directly otherwise. The child joins a new process group (detached) so the
 * shell can terminate the whole backend tree on exit.
 * @param command - backend executable (bundled node or the Electron binary in node mode).
 * @param args - backend arguments.
 * @param options - spawn options (env, stdio pipes, cwd).
 * @returns the spawned child.
 */
export function shellWrappedSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const shell = process.env.SHELL;
  const rc = shell === undefined || shell === "" ? "" : rcFileFor(shell);
  if (rc !== "" && process.platform !== "win32" && shell !== undefined) {
    const commandLine = `source ${rc} >/dev/null 2>&1; exec ${shellQuote(command)} ${args.map(shellQuote).join(" ")}`;
    return spawn(shell, ["-c", commandLine], { ...options, detached: true });
  }
  return spawn(command, [...args], { ...options, detached: process.platform !== "win32" });
}
