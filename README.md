# better-session

DeepSeek Harness 的**分支式会话编辑** monorepo：在不修改上游
`@deepseek-ai/*` 代码的前提下，为会话提供 **就地编辑 / 重试 / 分支**
（rewind / retry / fork）闭环。本文件只是索引，详细内容见各项目文档。

## 项目

| 项目                                        | 职责                                                                                       | 文档                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `packages/better-session/`                  | profile 聚合 bundle（安装 / 使用 / 配置）                                                  | [README](packages/better-session/README.md)                                              |
| `packages/session-branch/`                  | 契约层：`SessionBranchProvider` 抽象 + `SessionBranch` 服务 + 版本树投影                   | [README](packages/session-branch/README.md)                                              |
| `packages/session-rdb/`                     | 实现层：RDB 持久化（`PersistenceBackend`）+ 分支 provider（`SessionBranchProvider`）双服务 | [README](packages/session-rdb/README.md) · [design](packages/session-rdb/docs/design.md) |
| `packages/ui-conversation-message-actions/` | 编排层 + UI：edit / retry / fork 编排 + `conversation.chat.node` 渲染替换                  | [README](packages/ui-conversation-message-actions/README.md)                             |
| `packages/llm-openai-compatible/`           | LLM 适配层：OpenAI-compatible 多 provider 路由（可选组件）                                 | [README](packages/llm-openai-compatible/README.md)                                       |
| `apps/dsh-custom/`                          | 本地 GUI 应用壳（dsh-web-desktopify）                                                      | `just custom::dev` / `just custom::bundle`                                               |
| `vendor/`                                   | 上游 deepseek-harness side workspace（同步 / 裁剪 / 构建）                                 | [dsh-side-workspace-plugin-develop skill](.agents/skills/dsh-side-workspace-plugin-develop/SKILL.md)                            |

## 文档

| 文档                                                 | 内容                                      |
| ---------------------------------------------------- | ----------------------------------------- |
| [CONTEXT-MAP.md](CONTEXT-MAP.md)                     | 领域模型映射（术语表真源：会话编辑 / LLM 适配） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | 整体架构（布局 / 分层 / 核心设计 / 装配） |
| [docs/CODING_GUIDELINE.md](docs/CODING_GUIDELINE.md) | 项目约定（命令 / 代码 / 测试 / 发布）     |
| [AGENTS.md](AGENTS.md)                               | agent 工作指引（索引）                    |

决策（ADR）分三级存放：仓库级 [docs/adr/](docs/adr/)（上游 vendor 策略）、
上下文级 `packages/<pkg>/docs/adr/`（契约 / 编排 / 实现决策）、装配级
[packages/better-session/docs/adr/](packages/better-session/docs/adr/)。

## 快速入口

- 安装 / 使用 / 配置：[packages/better-session/README.md](packages/better-session/README.md)
- 本地开发命令：[justfile](justfile)
- 技术栈与上游版本：[mise.toml](mise.toml)
- 上游同步与适配流程：[.agents/skills/dsh-side-workspace-plugin-develop/SKILL.md](.agents/skills/dsh-side-workspace-plugin-develop/SKILL.md)
