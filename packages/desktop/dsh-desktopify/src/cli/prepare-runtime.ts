/**
 * Download and verify the upstream Node.js runtime for the packaged backend.
 * The backend runs under this bundled Node executable; the shell spawns it
 * directly (no user Node required). Downloads are cached under the target
 * workspace's `node_modules/.dsh-desktopify/downloads` and verified against
 * the official SHASUMS256.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { extract } from "tar";
import { buildRoot, resolveWorkspace } from "./workspace.ts";

const NODE_VERSION = "24.17.0";

type RuntimePlatform = "darwin" | "linux" | "win";
type RuntimeArch = "arm64" | "x64";

function target(): { platform: RuntimePlatform; arch: RuntimeArch } {
  const rawPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform;
  const rawArch = process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch;
  const platform = rawPlatform === "win32" ? "win" : rawPlatform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win") {
    throw new Error(`desktop runtime: unsupported platform ${rawPlatform}`);
  }
  if (rawArch !== "arm64" && rawArch !== "x64")
    throw new Error(`desktop runtime: unsupported architecture ${rawArch}`);
  return { platform, arch: rawArch };
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`desktop runtime: ${url} returned HTTP ${String(response.status)}`);
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
}

async function prepareNode(
  platform: RuntimePlatform,
  arch: RuntimeArch,
  buildRootDir: string,
): Promise<void> {
  const extension = platform === "win" ? "zip" : "tar.gz";
  const folder = `node-v${NODE_VERSION}-${platform}-${arch}`;
  const archiveName = `${folder}.${extension}`;
  const releaseRoot = `https://nodejs.org/download/release/v${NODE_VERSION}`;
  const downloadRoot = join(buildRootDir, "downloads");
  const archive = join(downloadRoot, archiveName);
  const sums = join(downloadRoot, `node-v${NODE_VERSION}-SHASUMS256.txt`);
  if (!existsSync(archive)) await download(`${releaseRoot}/${archiveName}`, archive);
  if (!existsSync(sums)) await download(`${releaseRoot}/SHASUMS256.txt`, sums);
  const line = (await readFile(sums, "utf8"))
    .split(/\r?\n/u)
    .find((candidate) => candidate.endsWith(`  ${archiveName}`));
  if (line === undefined)
    throw new Error(`desktop runtime: ${archiveName} is absent from Node.js SHASUMS256.txt`);
  const expected = line.split(/\s+/u)[0];
  const actual = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  if (actual !== expected) throw new Error(`desktop runtime: checksum mismatch for ${archiveName}`);

  const extraction = join(buildRootDir, "node-extract");
  rmSync(extraction, { recursive: true, force: true });
  mkdirSync(extraction, { recursive: true });
  if (platform === "win") await extractZip(archive, { dir: extraction });
  else await extract({ cwd: extraction, file: archive });
  const source = join(extraction, folder, platform === "win" ? "node.exe" : "bin/node");
  const destinationRoot = join(buildRootDir, "runtime", "node");
  const destination = join(destinationRoot, platform === "win" ? "node.exe" : "node");
  rmSync(destinationRoot, { recursive: true, force: true });
  mkdirSync(destinationRoot, { recursive: true });
  // A fresh write prevents macOS from retaining invalid code-signature vnode state from a tar-extracted Mach-O clone.
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx" }));
  if (platform !== "win") await chmod(destination, 0o755);
  const hostPlatform = process.platform === "win32" ? "win" : process.platform;
  const hostCanExecute =
    platform === hostPlatform &&
    (arch === process.arch ||
      (platform === "darwin" && arch === "x64" && process.arch === "arm64"));
  if (hostCanExecute) {
    const result = spawnSync(destination, ["--version"], { encoding: "utf8" });
    if (
      result.error !== undefined ||
      result.status !== 0 ||
      result.stdout.trim() !== `v${NODE_VERSION}`
    ) {
      const detail = result.error?.message ?? result.signal ?? result.stderr.trim();
      const outcome = detail === "" ? `exit ${String(result.status)}` : detail;
      throw new Error(
        `desktop runtime: prepared Node.js ${NODE_VERSION} failed executable verification: ${outcome}`,
      );
    }
  }
  rmSync(extraction, { recursive: true, force: true });
}

/** Options for the bundled-runtime preparation step of `bundle`. */
export interface PrepareRuntimeOptions {
  readonly workspace?: string;
}

export async function runPrepareRuntime(options: PrepareRuntimeOptions): Promise<void> {
  const { platform, arch } = target();
  const buildRootDir = buildRoot(resolve(options.workspace ?? resolveWorkspace()));
  const runtimeRoot = join(buildRootDir, "runtime");
  mkdirSync(join(buildRootDir, "downloads"), { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  await prepareNode(platform, arch, buildRootDir);
  writeFileSync(
    join(runtimeRoot, "versions.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        node: NODE_VERSION,
      },
      undefined,
      2,
    )}\n`,
  );
  console.log(`desktop runtime: prepared Node.js ${NODE_VERSION} for ${platform}-${arch}`);
}
