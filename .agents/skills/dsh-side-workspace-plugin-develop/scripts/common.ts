import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// 公共：workspace 根解析。
// DEEPSEEK_HARNESS_DIR 等路径约定为「相对 pnpm-workspace.yaml（workspace
// 根）」——pnpm 解析 workspace 成员以此为基准。脚本从任意 cwd 执行都应
// 先找到该根，再 resolve 环境变量路径，而不是相对 process.cwd()。

export function workspaceRootOf(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("找不到 pnpm-workspace.yaml（从执行目录向上）——无法确定 workspace 根");
    }
    dir = parent;
  }
}

export function requireWorkspaceEnv(name: string): { root: string; value: string } {
  const value = process.env[name];
  if (!value || value.length === 0) {
    console.error(`需要环境变量 ${name}`);
    process.exit(1);
  }
  return { root: workspaceRootOf(process.cwd()), value };
}
