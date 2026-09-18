import type { ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { rcFileFor, shellQuote, shellWrappedSpawn } from "../shell-env.ts";

const ORIGINAL_SHELL = process.env.SHELL;

async function firstInstalled(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 不在这个 runner 上，试下一个
    }
  }
  return undefined;
}

// 包装行为与具体 shell 无关，用 runner 上第一个带 rc 文件的 shell：CI（ubuntu-latest）没有 zsh。
const RC_SHELL = await firstInstalled(["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh"]);

function useRcShell(): string {
  if (RC_SHELL === undefined) throw new Error("runner has no bash/zsh to wrap with");
  process.env.SHELL = RC_SHELL;
  return RC_SHELL;
}

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runWrapped(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Outcome> {
  return new Promise<Outcome>((resolveOutcome, reject) => {
    const child: ChildProcess = shellWrappedSpawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolveOutcome({ code, stdout, stderr });
    });
  });
}

afterEach(() => {
  if (ORIGINAL_SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = ORIGINAL_SHELL;
});

describe("rcFileFor", () => {
  it("maps bash and zsh to their rc files, by basename", () => {
    expect(rcFileFor("bash")).toBe("~/.bashrc");
    expect(rcFileFor("/bin/bash")).toBe("~/.bashrc");
    expect(rcFileFor("/usr/local/bin/zsh")).toBe("~/.zshrc");
  });

  it("sources no rc file for other shells", () => {
    expect(rcFileFor("/usr/bin/fish")).toBe("");
    expect(rcFileFor("sh")).toBe("");
    expect(rcFileFor("")).toBe("");
  });
});

describe("shellQuote", () => {
  it("single-quotes a value and escapes embedded quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("shellWrappedSpawn", () => {
  it("runs the command directly when no rc file applies", async () => {
    delete process.env.SHELL;
    const outcome = await runWrapped(process.execPath, ["-p", "process.env.DSH_MARK"], {
      DSH_MARK: "direct",
    });

    expect(outcome.code).toBe(0);
    expect(outcome.stdout.trim()).toBe("direct");
  });

  it.skipIf(process.platform === "win32")(
    "runs the command through the login shell with quoted arguments intact",
    async () => {
      useRcShell();
      const outcome = await runWrapped("/bin/echo", ["a b'c", "d"]);

      expect(outcome.code).toBe(0);
      expect(outcome.stdout.trimEnd()).toBe("a b'c d");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the command in the same process, so its status is the shell's status",
    async () => {
      useRcShell();
      const outcome = await runWrapped("/bin/sh", ["-c", "exit 7"]);

      expect(outcome.code).toBe(7);
    },
  );

  it.skipIf(process.platform === "win32")(
    "passes the environment through the wrapper without leaking rc output",
    async () => {
      const shell = useRcShell();
      const outcome = await runWrapped(process.execPath, ["-p", "process.env.SHELL"]);

      expect(outcome.code).toBe(0);
      expect(outcome.stdout.trim()).toBe(shell);
      expect(outcome.stderr).toBe("");
    },
  );
});
