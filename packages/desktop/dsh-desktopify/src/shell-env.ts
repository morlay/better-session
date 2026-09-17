import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { basename } from "node:path";

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

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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
