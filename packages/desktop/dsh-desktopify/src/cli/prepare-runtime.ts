import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { extract } from "tar";
import { buildRoot, resolveWorkspace } from "./workspace.ts";

const NODE_VERSION = "24.17.0";

type RuntimePlatform = "darwin" | "linux" | "win";
type RuntimeArch = "arm64" | "x64";

interface CapturedCommand {
  readonly error?: Error;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// spawnSync 的异步等价：保留 error/status/signal/stdout/stderr 五个字段的语义
function capture(command: string, args: readonly string[]): Promise<CapturedCommand> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolvePromise({ error, status: null, signal: null, stdout, stderr });
    });
    child.once("close", (status, signal) => {
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

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
  await writeFile(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
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
  if (!(await pathExists(archive))) await download(`${releaseRoot}/${archiveName}`, archive);
  if (!(await pathExists(sums))) await download(`${releaseRoot}/SHASUMS256.txt`, sums);
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
  await rm(extraction, { recursive: true, force: true });
  await mkdir(extraction, { recursive: true });
  if (platform === "win") await extractZip(archive, { dir: extraction });
  else await extract({ cwd: extraction, file: archive });
  const source = join(extraction, folder, platform === "win" ? "node.exe" : "bin/node");
  const destinationRoot = join(buildRootDir, "runtime", "node");
  const destination = join(destinationRoot, platform === "win" ? "node.exe" : "node");
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx" }));
  if (platform !== "win") await chmod(destination, 0o755);
  const hostPlatform = process.platform === "win32" ? "win" : process.platform;
  const hostCanExecute =
    platform === hostPlatform &&
    (arch === process.arch ||
      (platform === "darwin" && arch === "x64" && process.arch === "arm64"));
  if (hostCanExecute) {
    const result = await capture(destination, ["--version"]);
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
  await rm(extraction, { recursive: true, force: true });
}

export interface PrepareRuntimeOptions {
  readonly workspace?: string;
}

export async function runPrepareRuntime(options: PrepareRuntimeOptions): Promise<void> {
  const { platform, arch } = target();
  const buildRootDir = buildRoot(resolve(options.workspace ?? resolveWorkspace()));
  const runtimeRoot = join(buildRootDir, "runtime");
  await mkdir(join(buildRootDir, "downloads"), { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await prepareNode(platform, arch, buildRootDir);
  await writeFile(
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
