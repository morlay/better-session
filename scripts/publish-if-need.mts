import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_REGISTRY = "https://npm.pkg.github.com/";

/** 解析 registry：`--registry <url>` 或 `--registry=<url>`，缺省用默认。 */
function resolveRegistry(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--registry") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error("missing value for --registry");
      }
      return value;
    }
    if (arg.startsWith("--registry=")) {
      return arg.slice("--registry=".length);
    }
  }
  return DEFAULT_REGISTRY;
}

/** 捕获 stdout/stderr 地跑子进程：非零退出不抛，交给调用方按退出码判断。 */
async function capture(
  command: string,
  args: string[],
): Promise<{ status: number | null; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(command, args, { encoding: "utf8" });
    return { status: 0, stderr };
  } catch (error: unknown) {
    const failure = error as { code?: unknown; stderr?: unknown };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
}

/** 继承 stdio 地跑子进程（发布日志直接进当前终端），返回退出码。 */
function runInherited(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}

const REGISTRY = resolveRegistry();

// turbo 在每个包自己的目录下运行本脚本，只处理当前包
const { name, version } = JSON.parse(await readFile("package.json", "utf8")) as {
  name: string;
  version: string;
};

// 只发布 @morlay/* 下的包：上游 @deepseek-ai/* 由 deepseek-harness 自己
// 发布，apps/* 等其余 workspace 成员不发布。
if (!name.startsWith("@morlay/")) {
  console.log(`skip ${name}: only @morlay/* packages are published from this repo`);
  process.exit(0);
}

const view = await capture("npm", [
  "view",
  `${name}@${version}`,
  "version",
  "--registry",
  REGISTRY,
]);
if (view.status === 0) {
  console.log(`skip ${name}: ${version} already published`);
  process.exit(0);
}
if (!view.stderr.includes("E404")) {
  process.stderr.write(view.stderr);
  process.exit(1);
}

console.log(`to publish: ${name}@${version}`);
const status = await runInherited("pnpm", [
  "publish",
  "--access=public",
  `--publish-branch=${process.env["GITHUB_REF_NAME"] ?? "main"}`,
  "--registry",
  REGISTRY,
]);
if (status !== 0) process.exit(status ?? 1);
