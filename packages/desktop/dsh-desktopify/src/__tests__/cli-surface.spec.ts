import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const MANIFEST = JSON.parse(
  await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { bin?: Record<string, string>; version?: string };

const BIN_NAME = Object.keys(MANIFEST.bin ?? {})[0] ?? "";
const BIN_COMMANDS = ["dev", "bundle"];

const roots: string[] = [];

async function nonWorkspaceDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-desktopify-cli-"));
  roots.push(root);
  return root;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(args: readonly string[], cwd?: string): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      ...(cwd === undefined ? {} : { cwd }),
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function listedCommands(help: string): string[] {
  const section = help.slice(help.indexOf("Commands:"));
  return section
    .split("\n")
    .slice(1)
    .map((line) => /^ {2}(\S+)/u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name !== "help");
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("published command surface", () => {
  it("names the program after the published bin entry", async () => {
    const { status, stdout } = await cli(["--help"]);

    expect(status).toBe(0);
    expect(BIN_NAME).not.toBe("");
    expect(/^Usage: (\S+)/u.exec(stdout)?.[1]).toBe(BIN_NAME);
  });

  it("exposes exactly the dev and bundle subcommands", async () => {
    const { stdout } = await cli(["--help"]);

    expect(listedCommands(stdout)).toEqual(BIN_COMMANDS);
    expect(stdout).not.toContain("prepare");
  });

  it("reports the package version", async () => {
    const { status, stdout } = await cli(["--version"]);

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(MANIFEST.version);
  });

  it("gives dev a browser flag and an optional workspace argument", async () => {
    const { status, stdout } = await cli(["dev", "--help"]);

    expect(status).toBe(0);
    expect(/--web\b/u.test(stdout)).toBe(true);
    expect(/\[workspace\]/u.test(stdout)).toBe(true);
    expect(/--dir\b/u.test(stdout)).toBe(false);
    expect(/--install\b/u.test(stdout)).toBe(false);
  });

  it("gives bundle the dir and install flags and an optional workspace argument", async () => {
    const { status, stdout } = await cli(["bundle", "--help"]);

    expect(status).toBe(0);
    expect(/--dir\b/u.test(stdout)).toBe(true);
    expect(/--install\b/u.test(stdout)).toBe(true);
    expect(/\[workspace\]/u.test(stdout)).toBe(true);
    expect(/--web\b/u.test(stdout)).toBe(false);
  });

  it("refuses an unknown subcommand", async () => {
    const { status, stderr } = await cli(["prepare:runtime"]);

    expect(status).not.toBe(0);
    expect(stderr).toContain("prepare:runtime");
  });
});

describe("workspace argument plumbing", () => {
  it("resolves the positional workspace instead of the working directory", async () => {
    const workspace = await nonWorkspaceDir();
    const { status, stderr } = await cli(["dev", workspace], await nonWorkspaceDir());

    expect(status).toBe(1);
    expect(stderr).toContain("no pnpm-workspace.yaml found above");
    expect(stderr).toContain(basename(workspace));
  });

  it("defaults the workspace to the working directory", async () => {
    const workspace = await nonWorkspaceDir();
    const { status, stderr } = await cli(["bundle"], workspace);

    expect(status).toBe(1);
    expect(stderr).toContain(basename(workspace));
    expect(stderr).toContain("package.json");
  });
});
