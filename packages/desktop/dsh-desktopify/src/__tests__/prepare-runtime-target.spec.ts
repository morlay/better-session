import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { create as createArchive } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrepareRuntime } from "../cli/prepare-runtime.ts";
import { buildRoot } from "../cli/workspace.ts";

const run = promisify(execFile);

// prepare-runtime.ts pins this release and names its download after it; the fixture stands in for the archive.
const NODE_VERSION = "24.17.0";
const PNPM_DIRECTORY = dirname(fileURLToPath(import.meta.resolve("pnpm/package.json")));

const ORIGINAL = {
  platform: process.env.DSH_DESKTOP_TARGET_PLATFORM,
  arch: process.env.DSH_DESKTOP_TARGET_ARCH,
};

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-desktopify-runtime-"));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

/** Every link the payload carries, at any depth. */
async function links(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) found.push(child);
    else if (entry.isDirectory()) found.push(...(await links(child)));
  }
  return found;
}

async function packageVersion(directory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string")
    throw new Error("fixture: pnpm manifest has no version");
  return manifest.version;
}

// A Node.js release archive for the running platform, holding a stand-in executable: it answers `--version`
// like the pinned release and hands anything else to this process's node, so runs through it are real ones.
async function nodeReleaseFixture(
  fixtureDir: string,
  platform: string,
  arch: string,
): Promise<{ name: string; archive: string; sums: string }> {
  const folder = `node-v${NODE_VERSION}-${platform}-${arch}`;
  const name = `${folder}.tar.gz`;
  const staging = join(fixtureDir, "staging");
  const executable = join(staging, folder, "bin", "node");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${NODE_VERSION}; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  const archive = join(fixtureDir, name);
  await createArchive({ cwd: staging, file: archive, gzip: true }, [folder]);
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const sums = join(fixtureDir, "SHASUMS256.txt");
  await writeFile(sums, `${digest}  ${name}\n`);
  return { name, archive, sums };
}

function stubNodeRelease(fixture: {
  name: string;
  archive: string;
  sums: string;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL): Promise<unknown> => {
    const url = String(input);
    if (url.endsWith(fixture.name))
      return { ok: true, arrayBuffer: async () => readFile(fixture.archive) };
    if (url.endsWith("SHASUMS256.txt"))
      return { ok: true, arrayBuffer: async () => readFile(fixture.sums) };
    throw new Error(`unexpected download ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  if (ORIGINAL.platform === undefined) delete process.env.DSH_DESKTOP_TARGET_PLATFORM;
  else process.env.DSH_DESKTOP_TARGET_PLATFORM = ORIGINAL.platform;
  if (ORIGINAL.arch === undefined) delete process.env.DSH_DESKTOP_TARGET_ARCH;
  else process.env.DSH_DESKTOP_TARGET_ARCH = ORIGINAL.arch;
});

describe("bundled runtime target", () => {
  it("refuses an unsupported platform before it writes or downloads anything", async () => {
    const workspace = await tempDir();
    process.env.DSH_DESKTOP_TARGET_PLATFORM = "solaris";

    await expect(runPrepareRuntime({ workspace })).rejects.toThrow(/unsupported platform solaris/u);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it("refuses an unsupported architecture", async () => {
    const workspace = await tempDir();
    process.env.DSH_DESKTOP_TARGET_PLATFORM = "linux";
    process.env.DSH_DESKTOP_TARGET_ARCH = "riscv64";

    await expect(runPrepareRuntime({ workspace })).rejects.toThrow(
      /unsupported architecture riscv64/u,
    );
  });

  it("treats a blank target platform as unsupported", async () => {
    process.env.DSH_DESKTOP_TARGET_PLATFORM = "";

    await expect(runPrepareRuntime({ workspace: await tempDir() })).rejects.toThrow(
      /unsupported platform/u,
    );
  });

  it("refuses a target its pnpm payload cannot serve before it downloads anything", async () => {
    const workspace = await tempDir();
    process.env.DSH_DESKTOP_TARGET_PLATFORM = process.platform;
    process.env.DSH_DESKTOP_TARGET_ARCH = process.arch === "arm64" ? "x64" : "arm64";

    await expect(runPrepareRuntime({ workspace })).rejects.toThrow(
      /bundled pnpm carries the \S+ native binary, which cannot serve \S+/u,
    );
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "bundles the runtime node, its bin directory and the pnpm payload",
    async () => {
      const workspace = await tempDir();
      const platform = process.platform;
      process.env.DSH_DESKTOP_TARGET_PLATFORM = platform;
      process.env.DSH_DESKTOP_TARGET_ARCH = process.arch;
      const fixture = await nodeReleaseFixture(join(workspace, "fixture"), platform, process.arch);
      const fetchMock = stubNodeRelease(fixture);

      await runPrepareRuntime({ workspace });

      const runtime = join(buildRoot(resolve(workspace)), "runtime");
      const pnpmVersion = await packageVersion(PNPM_DIRECTORY);
      expect(await readFile(join(runtime, "pnpm", "bin", "pnpm.mjs"), "utf8")).toBe(
        await readFile(join(PNPM_DIRECTORY, "bin", "pnpm.mjs"), "utf8"),
      );
      // The packaged app reaches nothing outside its own resources, so the payload owns every file it runs.
      expect(await links(join(runtime, "pnpm"))).toEqual([]);
      // It has to run on its own too: pnpm spawns the platform binary the payload carries, and with the
      // network refused here nothing else could supply it.
      const { stdout } = await run(
        process.execPath,
        [join(runtime, "pnpm", "bin", "pnpm.mjs"), "--version"],
        { env: { ...process.env, COREPACK_ENABLE_NETWORK: "0" } },
      );
      expect(stdout.trim()).toBe(pnpmVersion);
      expect(JSON.parse(await readFile(join(runtime, "versions.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        node: NODE_VERSION,
        pnpm: pnpmVersion,
      });

      const link = join(runtime, "bin", "node");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe("../node/node");
      expect(await readFile(link, "utf8")).toBe(
        await readFile(join(runtime, "node", "node"), "utf8"),
      );

      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls).toHaveLength(2);
      expect(
        urls.filter(
          (url) => !url.startsWith(`https://nodejs.org/download/release/v${NODE_VERSION}/`),
        ),
      ).toEqual([]);
    },
  );
});
