# 0001-上游以 side workspace 版本锁定完整代码而非发布版本

上游 deepseek-harness 改动频繁且处于 pre-release 阶段（`SESSION_FORMAT_VERSION`
保持 0、无兼容承诺），而本仓库的插件需要**完整源码上下文**才能扩展：类型
定义、事件映射、coordinator 内部状态（rewind 需同步其私有 `states`）、
`PersistenceBackend` 契约。因此把上游**按版本克隆的完整源码**以 side
workspace 形式 vendor 到 `vendor/deepseek-harness/`（独立 git 仓库，主仓库
gitignore），作为根 pnpm workspace 成员参与安装与构建，使 `@deepseek-ai/*`
各包解析到**当前固定版本**的源码——版本由 `mise.toml` 的
`DEEPSEEK_HARNESS_VERSION` 决定（对应上游分支 `dsh-v{version}`）。

## 考虑过的选项

- **用 npm 发布版本**（`@deepseek-ai/*` 包）：发布滞后于源码、只有 lib
  产物与 d.ts 而非源码（无法读 coordinator 私有实现）、无法打本地 patch；
  pre-release 阶段无兼容承诺，升级不可控。
- **直接依赖 git 远程**（`github:...`）：无版本锁定粒度（分支漂移）、无
  本地 patch 机制、pnpm 解析不稳定。

## 后果

- 上游 `@deepseek-ai/*` 代码**不可修改**（node_modules 只读；扩展走 cordis
  插件层）——vendor 只读，本地 patch 是例外且随 `just vendor sync` 重打
  （删 acp profile、删 subagent-codex / subagent-claude-code、
  css-inline-query patch）。
- 更新流程：`just vendor sync && just vendor build`，升级后
  验证 `just test` / `just lint` / `just build`（门禁与 CI 一致）。
- vendor 目录删除后必须重新 `just vendor sync` 才能恢复（`pnpm install`
  不会重新克隆）。
- 本仓库自己的包只在 `peerDependencies` 声明 `workspace:^` 的上游包名，
  不依赖 vendor 的构建脚本。
