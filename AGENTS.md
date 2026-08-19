# AGENTS.md

## 开始工作前必读

- 技术栈见 [mise.toml](./mise.toml)
- 可用命令见 [justfile](./justfile)
- **monorepo**（nub workspaces）：`packages/` 下三个包

```
packages/
├── session-branch/                     # 契约层 @morlay/session-branch（provider 抽象 + 版本树）
├── ui-conversation-message-actions/    # 编排层 + UI @morlay/ui-conversation-message-actions（rewind/retry/fork 完整功能 + conversation.chat.node 替换）
└── session-rdb/                        # 实现层 @morlay/session-rdb（RDB 持久化 + branch provider 双服务）
```

- 上游 `@deepseek-ai/*` 代码**不可修改**（node_modules 只读；扩展走 cordis 插件层）
- 工具链（tsdown / typescript / vitest / oxlint）在根；各包只声明自身运行时依赖
- 核心设计：`SessionBranchProvider` 是额外的 provider 抽象（与上游
  `PersistenceBackend` 平行）；rdb 同时实现两者并自动注册 `ctx.sessionBranch`
- **发布走 CI**：严禁本地私自 `pnpm publish`（包括用 `--registry` 指向
  GitHub Packages 的发布）。版本 bump 提交后由 CI 发布；本地只构建验证。
