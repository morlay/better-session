import { access, mkdir, mkdtemp, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopHost,
  materializeDesktopHost,
  officialClosure,
  officialDependencySpecs,
} from "../cli/official-deps.ts";
import * as office from "../desktop-host/office.ts";
import * as workspaceDependencies from "../../../../../vendor/deepseek-harness/apps/desktop-host/src/workspace-dependencies.ts";

const TOOL_ROOT = dirname(
  fileURLToPath(import.meta.resolve("@morlay/dsh-desktopify/package.json")),
);
/** The `@deepseek-ai/dsh-desktop-host` copy this workspace links for its own tooling. */
const WORKSPACE_HOST_DIR = dirname(
  fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-desktop-host/package.json")),
);
/** The built payload (gitignored): the variant's own product, absent before `pnpm build`. */
const HOST_ENTRY = join(TOOL_ROOT, "dist", "desktop-host", "lib", "index.js");
const BUILT = await access(HOST_ENTRY).then(
  () => true,
  () => false,
);

const roots: string[] = [];

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-host-variant-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface MountCall {
  readonly plugin: unknown;
  readonly config: unknown;
}

function recordingContext(calls: MountCall[]): never {
  return {
    plugin: async (plugin: unknown, config: unknown) => {
      calls.push({ plugin, config });
    },
  } as never;
}

async function plantHost(modulesDir: string): Promise<string> {
  const target = join(modulesDir, "@deepseek-ai", "dsh-desktop-host");
  await mkdir(join(target, "lib"), { recursive: true });
  await writeFile(join(target, "lib", "index.js"), "// host copied from elsewhere\n");
  await writeFile(
    join(target, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh-desktop-host", version: "9.9.9" })}\n`,
  );
  return target;
}

describe("desktop host variant", () => {
  it("mounts the bundled workspace dependencies and no skill provider", async () => {
    const calls: MountCall[] = [];
    const config = {
      source: "/payload/primary-runtime",
      root: "/harness-home/dsh-runtimes/payload",
    };

    await office.apply(recordingContext(calls), config);

    expect(calls.map((call) => (call.plugin as { name?: string }).name)).toEqual([
      "desktop-workspace-dependencies",
    ]);
    expect(calls[0]?.plugin).toBe(workspaceDependencies);
    expect(calls[0]?.config).toBe(config);
  });

  it.skipIf(!BUILT)("pins the host payload to the tool build, not the workspace copy", async () => {
    const host = await desktopHost();
    if (host === undefined) throw new Error(`the host payload is not built at ${HOST_ENTRY}`);

    expect(host.dir).toBe(join(TOOL_ROOT, "dist", "desktop-host"));
    expect(host.dir).not.toBe(resolve(WORKSPACE_HOST_DIR));
    expect(host.dir.split(/[\\/]/u)).not.toContain("node_modules");
  });

  it.skipIf(!BUILT)("pins every surface's host dependency to that payload", async () => {
    const specs = await officialDependencySpecs({
      workspace: TOOL_ROOT,
      workspaceRoot: process.cwd(),
      toolRoot: TOOL_ROOT,
      dshVersion: "workspace:^",
    });

    expect(specs["@deepseek-ai/dsh-desktop-host"]).toBe(
      `link:${join(TOOL_ROOT, "dist", "desktop-host")}`,
    );
  });

  it.skipIf(!BUILT)("injects that payload into the closure, not the workspace copy", async () => {
    const closure = await officialClosure({
      workspace: TOOL_ROOT,
      workspaceRoot: process.cwd(),
      toolRoot: TOOL_ROOT,
      dshVersion: "workspace:^",
    });
    const injected = closure.get("@deepseek-ai/dsh-desktop-host");

    expect(injected).toBe(join(TOOL_ROOT, "dist", "desktop-host"));
    expect(injected).not.toBe(resolve(WORKSPACE_HOST_DIR));
  });

  it.skipIf(!BUILT)("builds the variant entry in place of the upstream artifact", async () => {
    const built = await readFile(HOST_ENTRY, "utf8");

    expect(built).not.toContain("dsh-skill-office");
    expect(built).toContain("load_workspace_dependencies");
  });

  it.skipIf(!BUILT)("replaces a stale host payload already sitting in the closure", async () => {
    const modulesDir = join(await workDir(), "node_modules");
    const target = await plantHost(modulesDir);

    expect(await materializeDesktopHost(modulesDir)).toBe(target);

    const entry = await readFile(join(target, "lib", "index.js"), "utf8");
    expect(entry).not.toContain("host copied from elsewhere");
    expect(entry).toContain("load_workspace_dependencies");
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      version?: string;
    };
    expect(manifest.version).not.toBe("9.9.9");
  });

  it.skipIf(!BUILT)("replaces a host payload linked from another tree", async () => {
    const root = await workDir();
    const modulesDir = join(root, "node_modules");
    const linked = await plantHost(join(root, "workspace-link"));
    await mkdir(join(modulesDir, "@deepseek-ai"), { recursive: true });
    await symlink(linked, join(modulesDir, "@deepseek-ai", "dsh-desktop-host"), "dir");

    const target = await materializeDesktopHost(modulesDir);

    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(target, "lib", "index.js"), "utf8")).toContain(
      "load_workspace_dependencies",
    );
    expect(await readFile(join(linked, "lib", "index.js"), "utf8")).toBe(
      "// host copied from elsewhere\n",
    );
  });
});
