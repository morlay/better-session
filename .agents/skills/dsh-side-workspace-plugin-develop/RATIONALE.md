# 背景与取舍：为什么用 side workspace，而不是发布版本

> 本文解释 [SKILL.md](./SKILL.md) 所定义流程的**原因**（why），供执行前
> 理解，不作为操作步骤。

## 问题

要在不修改上游 `@deepseek-ai/*` 代码的前提下，开发跟随上游演进、且需要
版本可控的完整 cordis 插件集合。上游 deepseek-harness（dsh）处于
pre-release（`SESSION_FORMAT_VERSION` 保持 0、无兼容承诺）且改动频繁，
插件扩展往往依赖**发布包不含的上下文**：

- **上游私有实现**：许多扩展要协调上游服务内部状态（例如持久化后端的
  coordinator 私有 `states`），发布包只有 lib 产物与 d.ts。
- **类型 / 事件映射**：插件经 `SessionEventMap` declaration merging 扩展
  现有判别联合、按 `ignorable` 信封语义跳过事件——需要看上游事件定义与
  格式版本机制。
- **本地 patch**：上游偶发构建缺陷需最小补丁绕过；发布版本无法打 patch。
- **测试即契约**：上游自带测试是扩展点的活文档。

## 选择：按版本同步的 side workspace（完整 git 仓库）

把上游以**完整 git 仓库**形式放到 `vendor/<name>/`（保留 `.git`，独立于
主仓库版本控制，主仓库 gitignore），作为根 pnpm workspace 成员参与安装与
构建，使 `@deepseek-ai/*` 解析到该版本源码。同步用 git 操作（fetch +
reset + checkout 到版本），**不是删旧重克隆**——保留完整历史，可 diff、
可回退。版本由一处配置变量锁定（`DEEPSEEK_HARNESS_VERSION`，对应上游
分支 `dsh-v{version}`）。

**收益**：完整源码与私有实现上下文；类型与测试随版本固化；可打本地
patch；升级是显式动作（改一个变量 + git 同步 + 适配评估），完整历史在
手，diff 与回退天然可行。

**workspace 对齐的必要性**：上游仓库自带 pnpm workspace（自己的
`pnpm-workspace.yaml` 声明 `packages/*/*`、`vendor/*`、`native/*`、`apps/*`
等成员）。插件集合要拿到上游源码，主仓库的 workspace 必须把上游的每个
成员目录都映射进来（前缀 `vendor/<name>/`）——否则漏掉的成员会从
registry 解析成**发布副本**，与源码副本并存 → 同一 branded 类型 / 枚举
出现两份，tsc 下互不兼容（类型唯一性破坏）。这正是
`linkWorkspacePackages` / `hoistWorkspacePackages` / `autoInstallPeers`
三者必须为 true 的原因：内部互引一律链接、peer 依赖自动装到根、各插件
无需为每个上游包重复声明 devDeps。

## 被拒选项

- **npm 发布版本**：滞后于源码、只有 lib 产物无私有实现、无法打本地
  patch；pre-release 无兼容承诺，升级不可控。
- **git 远程依赖**（`github:...`）：无版本锁定粒度（分支漂移）、无本地
  patch 机制、pnpm 解析不稳定。

## 代价与约束

- **上游代码不可修改**是纪律：vendor 只读，本地 patch 是唯一例外且须
  登记（见 SKILL「本地 patch 管理」）。
- 升级不是「换个版本号」：上游改动可能触及插件依赖的契约面（见 SKILL
  「cordis 扩展面清单」），必须做适配评估。
- vendor 目录损坏 / 误删后需重新 clone 并重打 patch——任何 `pnpm install`
  都不会重建它（上游 build 内的 install 只装依赖、不克隆源码）。
