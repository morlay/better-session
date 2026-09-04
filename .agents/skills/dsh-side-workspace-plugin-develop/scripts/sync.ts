import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { requireWorkspaceEnv } from "./common.ts";

// 同步上游到指定提交（git 增量，不删目录）。约定：
//   env DEEPSEEK_HARNESS_DIR   上游目录，相对 pnpm-workspace.yaml 所在根
//   env DEEPSEEK_HARNESS_VERSION 目标版本（tag dsh-v{version} 优先，回退同名
//                              branch）——未设 REVISION 时使用
//   env DEEPSEEK_HARNESS_REVISION 可选，特定 git commit / 短 sha ——设置后
//                              优先于 VERSION（可指向任意上游提交，如 tag、
//                              branch 未覆盖的 commit）
//   env DEEPSEEK_HARNESS_REPO  可选，上游 remote（默认 deepseek-harness）
// 语义：
//   - 目录缺失 → 首次完整 clone（保留 .git）；
//   - 目录存在 → fetch（增量）+ reset --hard（清本地残留与旧 patch 修改，
//     版本/提交相同也要 reset——保证 repatch 干净基线）；
//   - 检出目标：REVISION（若有）> VERSION（tag → branch）。
// 同步后工作树是「目标提交未打补丁」状态——必须运行 patch 脚本再 build。
// 可从任意目录执行（workspace 根自动向上查找）。

const { value: dirValue, root } = requireWorkspaceEnv("DEEPSEEK_HARNESS_DIR");
const version = process.env.DEEPSEEK_HARNESS_VERSION;
const revision = process.env.DEEPSEEK_HARNESS_REVISION;

if (!version && !revision) {
  console.error("需要 DEEPSEEK_HARNESS_VERSION 或 DEEPSEEK_HARNESS_REVISION 之一");
  process.exit(1);
}

const dir = resolve(root, dirValue);
const repo =
  process.env.DEEPSEEK_HARNESS_REPO ??
  "https://github.com/deepseek-ai/deepseek-harness.git";
const tag = version ? `dsh-v${version}` : undefined;
const branch = version ? `dsh-v${version}` : undefined;
const branchName = `sync/${revision ?? tag ?? "unknown"}`;

function run(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

function shortHead(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return "(无 HEAD)";
  }
}

function hasCommit(cwd: string, rev: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const refs = [`+refs/tags/*:refs/tags/*`, `+refs/heads/*:refs/remotes/origin/*`];

if (existsSync(join(dir, ".git"))) {
  console.log(`[sync] 当前 HEAD: ${shortHead(dir)}`);
  // 完整 refs fetch：revision 可能指向任意 commit，无法预知属于哪个 tag/branch。
  run(["fetch", "--prune", "origin", ...refs], dir);
} else {
  console.log(`[sync] 首次 clone ${repo} -> ${dir}`);
  run(["clone", repo, dir], root);
}

// 清本地残留与旧 patch 修改（目标相同也要 reset——保证 repatch 干净基线）。
console.log(`[sync] reset --hard @ ${dir}`);
run(["reset", "--hard"], dir);

// 检出目标：REVISION（若有）> VERSION（tag → branch）。
let used: string;
let target: string;
if (revision) {
  target = revision;
  run(["checkout", "-B", branchName, target], dir);
  used = `revision ${target}`;
} else if (tag && hasCommit(dir, tag)) {
  target = tag;
  run(["checkout", "-B", branchName, target], dir);
  used = `tag ${tag}`;
} else if (branch) {
  target = `origin/${branch}`;
  run(["checkout", "-B", branchName, target], dir);
  used = `branch ${branch}`;
} else {
  console.error("没有可检出的目标（REVISION / VERSION 均无效）");
  process.exit(1);
}

console.log(`[sync] 已检出 ${used} @ ${shortHead(dir)}`);
console.log("[sync] 下一步必须运行 patch 脚本（repatch），再 build。");
