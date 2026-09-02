import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

const REGISTRY = resolveRegistry();

// turbo 在每个包自己的目录下运行本脚本，只处理当前包
const { name, version } = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  version: string;
};

// 只发布 @morlay/* 下的包：上游 @deepseek-ai/* 由 deepseek-harness 自己
// 发布，apps/* 等其余 workspace 成员不发布。
if (!name.startsWith("@morlay/")) {
  console.log(`skip ${name}: only @morlay/* packages are published from this repo`);
  process.exit(0);
}

const view = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry", REGISTRY], {
  encoding: "utf8",
});
if (view.status === 0) {
  console.log(`skip ${name}: ${version} already published`);
  process.exit(0);
}
if (!view.stderr.includes("E404")) {
  process.stderr.write(view.stderr);
  process.exit(1);
}

console.log(`to publish: ${name}@${version}`);
const publish = spawnSync(
  "pnpm",
  [
    "publish",
    "--access=public",
    `--publish-branch=${process.env["GITHUB_REF_NAME"] ?? "main"}`,
    "--registry",
    REGISTRY,
  ],
  {
    stdio: "inherit",
  },
);
if (publish.status !== 0) process.exit(publish.status ?? 1);
