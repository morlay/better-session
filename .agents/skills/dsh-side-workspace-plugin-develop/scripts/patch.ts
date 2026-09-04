import { existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { requireWorkspaceEnv } from "./common.ts";

// 对上游应用本地 patch（构建前置；必须在 sync 的干净基线上运行）。约定：
//   env DEEPSEEK_HARNESS_DIR  上游目录，相对 pnpm-workspace.yaml 所在根
//   env DEEPSEEK_HARNESS_EXCLUDE 可选，逗号分隔的「待裁剪包目录」完整相对
//      路径（相对上游根），如
//        packages/subagent/subagent-codex,packages/subagent/subagent-claude-code
//      对每个：删整个目录 + 从上游全部 tsconfig*.json 移除其 path 引用行。
//      用于裁剪不需要的上游包（构建依赖 / 体积 / 许可）。
//   步骤清单默认 <workspace 根>/patches/steps.json（EXCLUDE 之后执行；
//   env DEEPSEEK_HARNESS_STEPS 可覆盖清单路径）
// 清单每项：
//   - {"type":"rm","path":"apps/cli/tests/profiles/acp/cordis.yml"}
//   - {"type":"text","file":"tsconfig.host.json","pattern":正则,"flags":"gm","to":""}
//   - {"type":"git","patch":"css-inline-query.patch"}  相对 <workspace 根>/patches/
// 任一失败即失败（不跳过）。可从任意目录执行。

const { value: dirValue, root } = requireWorkspaceEnv("DEEPSEEK_HARNESS_DIR");
const dir = resolve(root, dirValue);
const patchesRoot = process.env.DEEPSEEK_HARNESS_PATCHES
  ? resolve(root, process.env.DEEPSEEK_HARNESS_PATCHES)
  : join(root, "patches");
const stepsPath = process.env.DEEPSEEK_HARNESS_STEPS ?? join(patchesRoot, "steps.json");
const exclude =
  process.env.DEEPSEEK_HARNESS_EXCLUDE
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) ?? [];

if (!existsSync(dir) || !existsSync(join(dir, ".git"))) {
  console.error(`上游目录不存在或非 git 仓库: ${dir}（先跑 sync）`);
  process.exit(1);
}

// ---- 步骤 0：DEEPSEEK_HARNESS_EXCLUDE 裁剪（先于 steps.json）----
function tsconfigFiles(): string[] {
  const found: string[] = [];
  const walk = (dirPath: string): void => {
    if (!existsSync(dirPath)) return;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (entry.name.startsWith("tsconfig") && entry.name.endsWith(".json")) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

for (const target of exclude) {
  const abs = join(dir, target);
  if (existsSync(abs)) {
    console.log(`[exclude] rm ${target}`);
    rmSync(abs, { recursive: true, force: true });
  } else {
    console.warn(`[exclude] 不存在，跳过: ${target}`);
  }
  // 从全部 tsconfig*.json 移除引用该目录的 path 行（形如 { "path": "./packages/..." }）
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ref = new RegExp(
    `^\\s*\\{?\\s*"path":\\s*"[^"]*${esc}"\\s*,?\\s*\\}?\\s*,?$`,
    "m",
  );
  for (const file of tsconfigFiles()) {
    const content = readFileSync(file, "utf8");
    const next = content.replace(ref, "");
    if (next !== content) {
      console.log(`[exclude] tsconfig 移除引用: ${file.replace(dir + "/", "")}`);
      writeFileSync(file, next);
    }
  }
}

// ---- 步骤 1+：patches/steps.json 步骤清单 ----
if (!existsSync(stepsPath)) {
  console.error(`patch 步骤清单不存在: ${stepsPath}`);
  process.exit(1);
}

type Step =
  | { type: "rm"; path: string }
  | { type: "text"; file: string; pattern: string; flags?: string; to?: string }
  | { type: "git"; patch: string };

const steps: Step[] = JSON.parse(readFileSync(stepsPath, "utf8"));
for (const step of steps) {
  if (step.type === "rm") {
    const target = join(dir, step.path);
    console.log(`[patch] rm ${step.path}`);
    rmSync(target, { recursive: true, force: true });
  } else if (step.type === "text") {
    const file = join(dir, step.file);
    if (!existsSync(file)) throw new Error(`patch 目标不存在: ${step.file}`);
    const content = readFileSync(file, "utf8");
    const pattern = new RegExp(step.pattern, step.flags ?? "");
    if (!pattern.test(content)) throw new Error(`patch 正则未匹配: ${step.file}`);
    const next = content.replace(pattern, step.to ?? "");
    if (next === content) throw new Error(`patch 未产生变化: ${step.file}`);
    console.log(`[patch] text ${step.file}`);
    writeFileSync(file, next);
  } else if (step.type === "git") {
    const patch = join(patchesRoot, step.patch);
    if (!existsSync(patch)) throw new Error(`patch 文件不存在: ${step.patch}`);
    console.log(`[patch] git apply ${step.patch}`);
    execFileSync("git", ["apply", patch], { cwd: dir, stdio: "inherit" });
  } else {
    throw new Error(`未知 patch 步骤: ${JSON.stringify(step)}`);
  }
}
