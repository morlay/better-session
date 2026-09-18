import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROFILE_RUNTIME_REPORT_NAME,
  installProfile,
  runtimeOverrides,
  workspaceWithOverrides,
} from "../profile-project.ts";

const roots: string[] = [];

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-profile-"));
  roots.push(root);
  return root;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SETTINGS = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  node-pty: true
`;

function report(entries: readonly { name: string; path: string }[]): string {
  return `${JSON.stringify({ schemaVersion: 1, runtimePackages: entries }, undefined, 2)}\n`;
}

describe("profile overrides", () => {
  it("links every reported runtime package to its directory inside the runtime", async () => {
    const profile = await workDir();
    const runtime = await workDir();
    await write(
      join(profile, PROFILE_RUNTIME_REPORT_NAME),
      report([
        { name: "@deepseek-ai/dsh-llm", path: "node_modules/@deepseek-ai/dsh-llm" },
        {
          name: "@morlay/dsh-client-ui-conversation",
          path: "node_modules/.pnpm/@morlay+better-session@file+/node_modules/@morlay/dsh-client-ui-conversation",
        },
      ]),
    );

    expect(await runtimeOverrides(profile, runtime)).toEqual([
      { name: "@deepseek-ai/dsh-llm", target: join(runtime, "node_modules/@deepseek-ai/dsh-llm") },
      {
        name: "@morlay/dsh-client-ui-conversation",
        target: join(
          runtime,
          "node_modules/.pnpm/@morlay+better-session@file+/node_modules/@morlay/dsh-client-ui-conversation",
        ),
      },
    ]);
  });

  it("fails loud when the seed wrote no runtime package report", async () => {
    const profile = await workDir();
    await expect(runtimeOverrides(profile, "/runtime")).rejects.toThrow(
      new RegExp(PROFILE_RUNTIME_REPORT_NAME, "u"),
    );
  });

  it("rejects a report whose package list is not an entry array", async () => {
    const profile = await workDir();
    await write(
      join(profile, PROFILE_RUNTIME_REPORT_NAME),
      `${JSON.stringify({ schemaVersion: 1, runtimePackages: [7] })}\n`,
    );
    await expect(runtimeOverrides(profile, "/runtime")).rejects.toThrow(/runtimePackages/u);
  });

  it("rejects an entry without a runtime path", async () => {
    const profile = await workDir();
    await write(
      join(profile, PROFILE_RUNTIME_REPORT_NAME),
      report([{ name: "@deepseek-ai/dsh-llm", path: "" }]),
    );
    await expect(runtimeOverrides(profile, "/runtime")).rejects.toThrow(/runtimePackages/u);
  });
});

describe("profile workspace settings", () => {
  it("appends the runtime overrides after the profile settings", () => {
    const text = workspaceWithOverrides(SETTINGS, [
      { name: "@deepseek-ai/dsh-llm", target: "/app/runtime/node_modules/@deepseek-ai/dsh-llm" },
    ]);

    expect(text).toContain("nodeLinker: hoisted");
    expect(text).toContain("allowBuilds:\n  node-pty: true\n");
    expect(text).toContain(
      'overrides:\n  "@deepseek-ai/dsh-llm": "link:/app/runtime/node_modules/@deepseek-ai/dsh-llm"\n',
    );
  });

  it("replaces the overrides it wrote on an earlier launch", () => {
    const first = workspaceWithOverrides(SETTINGS, [{ name: "a", target: "/one/a" }]);
    const second = workspaceWithOverrides(first, [{ name: "b", target: "/two/b" }]);

    expect(second.match(/overrides:/gu)).toHaveLength(1);
    expect(second).not.toContain("/one/a");
    expect(second).toContain('"b": "link:/two/b"');
  });

  it("keeps the settings untouched when no runtime package is overridden", () => {
    expect(workspaceWithOverrides(SETTINGS, [])).toBe(SETTINGS);
  });

  it("keeps a hand-edited overrides block when the runtime list is empty", () => {
    const edited = `${SETTINGS}overrides:\n  "left": "1.0.0"\n`;

    expect(workspaceWithOverrides(edited, [])).toBe(edited);
  });
});

describe("profile installation", () => {
  const spawnStub = (calls: { command: string; args: readonly string[]; cwd: string }[]) =>
    ((command: string, args: readonly string[], options: { cwd?: string }) => {
      calls.push({ command, args, cwd: String(options.cwd) });
      return {
        on: (event: string, listener: (...rest: unknown[]) => void) => {
          if (event === "close")
            setImmediate(() => {
              listener(0, null);
            });
          return undefined;
        },
        once: (event: string, listener: (...rest: unknown[]) => void) => {
          if (event === "close")
            setImmediate(() => {
              listener(0, null);
            });
          return undefined;
        },
      };
    }) as unknown as typeof import("node:child_process").spawn;

  it("installs the profile offline with the bundled pnpm entry", async () => {
    const profile = await workDir();
    const calls: { command: string; args: readonly string[]; cwd: string }[] = [];

    await installProfile({
      node: "/app/runtime/node/node",
      pnpmEntry: "/app/runtime/pnpm/bin/pnpm.mjs",
      profileDir: profile,
      spawn: spawnStub(calls),
    });

    expect(calls).toEqual([
      {
        command: "/app/runtime/node/node",
        args: [
          "/app/runtime/pnpm/bin/pnpm.mjs",
          "install",
          "--prod",
          "--ignore-scripts",
          "--offline",
        ],
        cwd: profile,
      },
    ]);
  });

  it("reports the pnpm exit status when the installation fails", async () => {
    const profile = await workDir();
    const failing = ((_command: string, _args: readonly string[], _options: unknown) => ({
      once: (event: string, listener: (...rest: unknown[]) => void) => {
        if (event === "close")
          setImmediate(() => {
            listener(1, null);
          });
        return undefined;
      },
      on: (event: string, listener: (...rest: unknown[]) => void) => {
        if (event === "close")
          setImmediate(() => {
            listener(1, null);
          });
        return undefined;
      },
    })) as unknown as typeof import("node:child_process").spawn;

    await expect(
      installProfile({
        node: "/app/runtime/node/node",
        pnpmEntry: "/app/runtime/pnpm/bin/pnpm.mjs",
        profileDir: profile,
        spawn: failing,
      }),
    ).rejects.toThrow(/profile install/u);
  });
});
