import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { requireWorkspaceEnv } from "./common.ts";

// 干净构建完整上游（构建前置：需先跑 patch）。约定：
//   env DEEPSEEK_HARNESS_DIR 上游目录，相对 pnpm-workspace.yaml 所在根
//   env DEEPSEEK_HARNESS_NO_CLEAN 设 1 时保留 node_modules（默认清理）
// 在上游目录内 pnpm install && pnpm run build，随后清理其 node_modules。
// 可从任意目录执行。

const { root, value: dirValue } = requireWorkspaceEnv("DEEPSEEK_HARNESS_DIR");
const dir = resolve(root, dirValue);
if (!existsSync(dir)) {
  console.error(`上游目录不存在: ${dir}（先跑 sync）`);
  process.exit(1);
}

function run(args: string[], cwd: string): void {
  execFileSync("pnpm", args, { cwd, stdio: "inherit" });
}

console.log(`[build] pnpm install @ ${dir}`);
run(["install"], dir);
console.log(`[build] pnpm run build @ ${dir}`);
run(["run", "build"], dir);

if (process.env.DEEPSEEK_HARNESS_NO_CLEAN !== "1") {
  console.log(`[build] clean node_modules @ ${dir}`);
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
}
console.log("[build] done");
