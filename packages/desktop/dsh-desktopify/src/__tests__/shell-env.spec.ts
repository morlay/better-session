import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { rcFileFor, shellQuote, shellWrappedSpawn } from "../shell-env.ts";

const ORIGINAL_SHELL = process.env.SHELL;

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
      process.env.SHELL = "/bin/bash";
      const outcome = await runWrapped("/bin/echo", ["a b'c", "d"]);

      expect(outcome.code).toBe(0);
      expect(outcome.stdout.trimEnd()).toBe("a b'c d");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the command in the same process, so its status is the shell's status",
    async () => {
      process.env.SHELL = "/bin/zsh";
      const outcome = await runWrapped("/bin/sh", ["-c", "exit 7"]);

      expect(outcome.code).toBe(7);
    },
  );

  it.skipIf(process.platform === "win32")(
    "passes the environment through the wrapper without leaking rc output",
    async () => {
      process.env.SHELL = "/bin/bash";
      const outcome = await runWrapped(process.execPath, ["-p", "process.env.SHELL"]);

      expect(outcome.code).toBe(0);
      expect(outcome.stdout.trim()).toBe("/bin/bash");
      expect(outcome.stderr).toBe("");
    },
  );
});
