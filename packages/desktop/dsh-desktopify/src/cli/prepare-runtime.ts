import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { extract } from "tar";
import { buildRoot, resolveWorkspace } from "./workspace.ts";

const NODE_VERSION = "24.17.0";
const PNPM_MANIFEST = "pnpm/package.json";
const PNPM_NATIVE_HELPERS = "pnpm/native-binary.mjs";
// What the runtime entry loads: its wrapper, the node-gyp payload the native binary runs builds with, and what
// redistribution owes. pnpm's install script relinks the package's own `pnpm` shim to the platform binary, so
// copying the package wholesale would ship that 36 MB binary twice.
const PNPM_PAYLOAD = ["bin", "dist", "native-binary.mjs", "package.json", "THIRD-PARTY-NOTICES.md"];

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

function hostPlatform(): string {
  return process.platform === "win32" ? "win" : process.platform;
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
  const hostCanExecute =
    platform === hostPlatform() &&
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

/**
 * pnpm 12 publishes the npm package as a wrapper whose `bin/pnpm.mjs` spawns the CLI, which itself ships as a
 * per-platform native binary in a package of its own. A bundle needs both halves, and only the build host's
 * platform package is installable here, so the payload cannot serve another target.
 */
function requireBundledPnpmTarget(platform: RuntimePlatform, arch: RuntimeArch): void {
  const host = `${hostPlatform()}-${process.arch}`;
  if (host === `${platform}-${arch}`) return;
  throw new Error(
    `desktop runtime: bundled pnpm carries the ${host} native binary, which cannot serve ${platform}-${arch}`,
  );
}

interface PnpmPayload {
  /** Directory of the published wrapper; the runtime entry is its `bin/pnpm.mjs`. */
  readonly directory: string;
  readonly version: string;
  /** Native binary the wrapper spawns. */
  readonly nativeBinary: string;
}

/** Resolve the wrapper and the platform package this install carries; pnpm's own lookup is the only source. */
async function resolvePnpm(): Promise<PnpmPayload> {
  const manifest = fileURLToPath(import.meta.resolve(PNPM_MANIFEST));
  const { version } = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || version === "")
    throw new Error("desktop runtime: pnpm manifest has no version");
  const helpers = (await import(
    pathToFileURL(fileURLToPath(import.meta.resolve(PNPM_NATIVE_HELPERS))).href
  )) as { readonly resolveInstalledBinary?: () => string | null };
  const nativeBinary = helpers.resolveInstalledBinary?.() ?? null;
  if (nativeBinary === null)
    throw new Error(
      `desktop runtime: pnpm ${version} has no native binary for ${hostPlatform()}-${process.arch}; ` +
        "install the workspace without skipping optional dependencies",
    );
  return { directory: dirname(manifest), version, nativeBinary };
}

/** Copy the wrapper's closure and its platform package to `<runtime>/pnpm`, where the host gets the entry. */
async function preparePnpm(platform: RuntimePlatform, runtimeRoot: string): Promise<string> {
  const pnpm = await resolvePnpm();
  const destination = join(runtimeRoot, "pnpm");
  const nativePackage = dirname(pnpm.nativeBinary);
  // The wrapper resolves its platform package in the wrapper's own `node_modules`, so the scope and package
  // directory levels it sat in are reproduced there — where the bundled wrapper will search for it.
  const bundledPackage = join(
    destination,
    "node_modules",
    basename(dirname(nativePackage)),
    basename(nativePackage),
  );
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const entry of PNPM_PAYLOAD) {
    await cp(join(pnpm.directory, entry), join(destination, entry), {
      recursive: true,
      dereference: true,
    });
  }
  // The platform package reaches us as a link into the store, so the payload takes its files, not the link.
  await cp(nativePackage, bundledPackage, { recursive: true, dereference: true });
  await verifyPnpm(platform, destination, pnpm.version);
  return pnpm.version;
}

/** The packaged app has no route back to this workspace, so the payload has to run before it is packaged. */
async function verifyPnpm(
  platform: RuntimePlatform,
  pnpmRoot: string,
  version: string,
): Promise<void> {
  const runtimeRoot = dirname(pnpmRoot);
  const node = join(runtimeRoot, "node", platform === "win" ? "node.exe" : "node");
  const result = await capture(node, [join(pnpmRoot, "bin", "pnpm.mjs"), "--version"]);
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim() !== version) {
    const detail = result.error?.message ?? result.signal ?? result.stderr.trim();
    const outcome = detail === "" ? `exit ${String(result.status)}` : detail;
    throw new Error(
      `desktop runtime: bundled pnpm ${version} failed executable verification: ${outcome}`,
    );
  }
}

/** `<runtime>/bin` is prepended to the PATH of the host's pnpm child, so its `node` must be the bundled one. */
async function prepareBin(platform: RuntimePlatform, runtimeRoot: string): Promise<void> {
  const binRoot = join(runtimeRoot, "bin");
  await rm(binRoot, { recursive: true, force: true });
  await mkdir(binRoot, { recursive: true });
  if (platform === "win") {
    await cp(join(runtimeRoot, "node", "node.exe"), join(binRoot, "node.exe"));
    return;
  }
  await symlink("../node/node", join(binRoot, "node"), "file");
}

export async function runPrepareRuntime(options: PrepareRuntimeOptions): Promise<void> {
  const { platform, arch } = target();
  requireBundledPnpmTarget(platform, arch);
  const buildRootDir = buildRoot(resolve(options.workspace ?? resolveWorkspace()));
  const runtimeRoot = join(buildRootDir, "runtime");
  await mkdir(join(buildRootDir, "downloads"), { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await prepareNode(platform, arch, buildRootDir);
  const pnpmVersion = await preparePnpm(platform, runtimeRoot);
  await prepareBin(platform, runtimeRoot);
  await writeFile(
    join(runtimeRoot, "versions.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        node: NODE_VERSION,
        pnpm: pnpmVersion,
      },
      undefined,
      2,
    )}\n`,
  );
  console.log(
    `desktop runtime: prepared Node.js ${NODE_VERSION} and pnpm ${pnpmVersion} for ${platform}-${arch}`,
  );
}
