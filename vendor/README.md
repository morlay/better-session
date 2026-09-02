# vendor

本目录承载**上游 side workspace**：`vendor/deepseek-harness/` 是上游
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码的
按版本克隆，作为根 pnpm workspace 的成员参与安装与构建，使
`@deepseek-ai/*` 各包解析到**当前固定版本**的源码。

- `vendor/deepseek-harness/` 是**独立 git 仓库**（主仓库 gitignore，不进
  root 版本库）。
- 版本由 [mise.toml](../mise.toml) 的 `DEEPSEEK_HARNESS_VERSION` 决定
  （当前 `0.1.2-alpha.2`），对应上游分支 `dsh-v{DEEPSEEK_HARNESS_VERSION}`。
- 上游 `@deepseek-ai/*` 代码**不可修改**（扩展走 cordis 插件层）。

## 更新上游

```sh
just vendor::sync && just dep && just vendor::build
```

> 前置条件：命令依赖 [mise.toml](../mise.toml) 的
> `DEEPSEEK_HARNESS_VERSION` 环境变量，请在 mise 环境下执行
> （`mise exec -- just vendor::sync`，或 shell 已 `mise activate`）。

| 步骤        | 命令                 | 做什么                                                                                          |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| 1. 同步上游 | `just vendor::sync`  | 删除旧 `vendor/deepseek-harness/`，按 `DEEPSEEK_HARNESS_VERSION` 浅克隆上游分支，并打本地 patch |
| 2. 安装依赖 | `just dep`           | `pnpm install`：把 vendor 纳入根 workspace（更新 `pnpm-lock.yaml`）                             |
| 3. 构建上游 | `just vendor::build` | 在上游目录内 `pnpm run build`（产出 `lib/`）并清理其 `node_modules`                             |

升级后验证：`just test`、`just lint`、`just build`（门禁与 CI 一致）。

## `just vendor::sync` 的本地 patch

`sync` 克隆完成后对上游打以下 patch（`vendor/justfile`）：

- 删除 `apps/cli/tests/profiles/acp/cordis.yml`
- 删除 `packages/subagent/subagent-codex`、`packages/subagent/subagent-claude-code`
- `sed` 从 `tsconfig.host.json` 移除上述两个 subagent 包的引用
- `git apply patches/css-inline-query.patch`：把 `tsdown.client.ts` 的 CSS
  `resolveId` 钩子改为 `pre` 顺序。rolldown 1.1.1 在默认顺序钩子前剥离
  `?inline` 查询并在返回的虚拟 id 上重新追加，导致 `dsh-css-text-inline`
  永不匹配、`?inline` 样式落入 `dsh-css-global-inline` 后 `load` 切片得到
  `base.css.mjs?in` 而 ENOENT；`pre` 顺序保留原始 specifier。

## 注意

- `vendor/deepseek-harness/` 是独立 git 仓库：升级前可在其内部记录原
  HEAD，升级后 `git diff` / `git log` 查看上游变化。
- vendor 构建产物 `lib/` 被 dsh 加载；删掉 vendor 目录后必须重新执行
  `just vendor::sync` 才能恢复（`pnpm install` 不会重新克隆）。
- 本仓库自己的包不依赖 vendor 的构建脚本，只在 `peerDependencies` 中
  声明 `workspace:^` 的上游包名。
