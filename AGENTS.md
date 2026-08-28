# AGENTS.md

## 开始工作前必读

- 技术栈与版本（node / pnpm / just / 上游版本）：[mise.toml](./mise.toml)
- 常用命令：[justfile](./justfile)
- 整体架构（仓库布局 / 分层 / 核心设计 / 装配）：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 项目约定（命令 / 代码 / 测试 / 发布）：[docs/CODING_GUIDELINE.md](docs/CODING_GUIDELINE.md)
- 上游 deepseek-harness 更新流程：[vendor/README.md](vendor/README.md)

## 红线

- 上游 `@deepseek-ai/*` 代码**不可修改**（node_modules 只读；扩展走 cordis 插件层）
- **发布走 CI**：严禁本地私自 `pnpm publish`（包括用 `--registry` 指向
  GitHub Packages 的发布）。版本 bump 提交后由 CI 发布；本地只构建验证。
