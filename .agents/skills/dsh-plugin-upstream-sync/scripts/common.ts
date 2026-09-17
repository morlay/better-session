import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

// 公共：workspace 根解析 + 异步进程 / 文件系统小工具。
// DEEPSEEK_HARNESS_DIR 等路径约定为「相对 pnpm-workspace.yaml（workspace
// 根）」——pnpm 解析 workspace 成员以此为基准。脚本从任意 cwd 执行都应
// 先找到该根，再 resolve 环境变量路径，而不是相对 process.cwd()。

const execFileAsync = promisify(execFile);

// existsSync 的异步等价物：stat 失败（不存在 / 不可访问）即 false。
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// execFileSync(..., { encoding: "utf8" }) 的异步等价物：捕获 stdout。
export async function execFileCapture(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, encoding: "utf8" });
  return stdout;
}

type CommandFailure = Error & { status: number | null; signal: NodeJS.Signals | null };

// 与 node 的 execFileSync 失败文案保持一致（"Command failed: <cmd> <args>"）。
function commandFailed(
  command: string,
  args: readonly string[],
  code: number | null,
  signal: NodeJS.Signals | null,
): CommandFailure {
  return Object.assign(new Error(`Command failed: ${command} ${args.join(" ")}`), {
    status: code,
    signal,
  });
}

// execFileSync(..., { stdio: "inherit" }) 的异步等价物：子进程 stdio 直连
// 终端（流式输出不变），仍以 Promise reject 表达非零退出 / 信号 / 启动失败，
// 使「命令失败即失败」的语义不变。
export async function runInherited(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(commandFailed(command, args, code, signal));
    });
  });
}

export async function workspaceRootOf(start: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    if (await pathExists(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("找不到 pnpm-workspace.yaml（从执行目录向上）——无法确定 workspace 根");
    }
    dir = parent;
  }
}

export async function requireWorkspaceEnv(name: string): Promise<{ root: string; value: string }> {
  const value = process.env[name];
  if (!value || value.length === 0) {
    console.error(`需要环境变量 ${name}`);
    process.exit(1);
  }
  return { root: await workspaceRootOf(process.cwd()), value };
}
