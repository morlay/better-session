# better-session

DeepSeek Harness 的**分支式会话编辑** monorepo：在不修改上游
`@deepseek-ai/*` 代码的前提下，为会话提供 **就地编辑 / 重试 / 撤回 / 分支**
（rewind / retry / recall / fork）闭环。本文件只是索引，详细内容见各项目文档。

## 项目

包按 `packages/<family>/<pkg>` 两层存放，family 即上下文分组；术语表与归属见
[`.agents/CONTEXT-MAP.md`](.agents/CONTEXT-MAP.md)。

| 包                                                            | 职责                                                                    | 文档                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **session**（会话编辑）                                       |                                                                         |                                                                                                                                                   |
| `session/better-session/`                                     | 聚合层：profile bundle（安装 / 使用 / 配置）                            | [README](packages/session/better-session/README.md)                                                                                               |
| `session/session-branch/`                                     | 契约层：分支 provider 抽象 + 版本树投影                                 | [README](packages/session/session-branch/README.md) · [词汇](.agents/CONTEXT.md)                                                                  |
| `session/session-rdb/`                                        | 实现层：RDB 持久化 + 分支 provider + storages / 查询接管                | [README](packages/session/session-rdb/README.md) · [design](packages/session/session-rdb/.agents/designs/0001-设计总览.md)                        |
| `session/ui-conversation-message-actions/`                    | 编排层：edit / retry / recall / fork 编排 + client UI 替换              | [README](packages/session/ui-conversation-message-actions/README.md)                                                                              |
| `session/ui-conversation/` · `ui-chat/` · `ui-input-trigger/` | 上游对话 UI 的 **fork**（host 半 + client 半，整包逐字复制）            | [债务 0001](.agents/debts/0001-临时接管上游对话UI的client半.md)                                                                                   |
| `session/dsh-reference-injection/`                            | skill 引用后注入（`skill:name` → `<skill_content>`）                    | [README](packages/session/dsh-reference-injection/README.md)                                                                                      |
| **client**（浏览器半基础）                                    |                                                                         |                                                                                                                                                   |
| `client/ui-primitives/`                                       | CSS-in-JS 样式层 + 引用统一解析 / 渲染转换                              | [README](packages/client/ui-primitives/README.md) · [ADR-0001](packages/client/ui-primitives/.agents/adrs/0001-css-in-js样式层与官方token消费.md) |
| **llm**（LLM 适配）                                           |                                                                         |                                                                                                                                                   |
| `llm/llm-openai-compatible/`                                  | OpenAI-compatible 多 provider 路由（可选组件）                          | [README](packages/llm/llm-openai-compatible/README.md) · [词汇](packages/llm/llm-openai-compatible/.agents/CONTEXT.md)                            |
| **preset**（profile 预设）                                    |                                                                         |                                                                                                                                                   |
| `preset/dsh-preset/`                                          | 个人 profile bundle：生成标准 / ptc preset、声明 pi-ai 路由、沙箱规则   | [README](packages/preset/dsh-preset/README.md)                                                                                                    |
| `preset/dsh-prompt-reminder/`                                 | 精简 system prompt 被裁掉的小节降级为 `<system-reminder>` 用户消息      | [README](packages/preset/dsh-prompt-reminder/README.md)                                                                                           |
| **sandbox**（沙箱替换）                                       |                                                                         |                                                                                                                                                   |
| `sandbox/dsh-sandbox-local/`                                  | 额外可写根 + 拒绝项（替换 `ctx.sandbox` / `ctx.fs`）                    | [README](packages/sandbox/dsh-sandbox-local/README.md)                                                                                            |
| **desktop**（桌面化）                                         |                                                                         |                                                                                                                                                   |
| `desktop/dsh-desktopify/`                                     | 桌面化打包工具（`dsh-desktopify` CLI：dev / bundle）                    | [README](packages/desktop/dsh-desktopify/README.md)                                                                                               |
| **workspace**（非发布）                                       |                                                                         |                                                                                                                                                   |
| `apps/dsh-custom-next/`                                       | 示例工作区：web 模式（`dsh web`）与 desktop 模式（Electron 壳）         | [justfile](apps/dsh-custom-next/justfile) · `just custom desktop`                                                                                 |
| `devpackages/devkit/`                                         | 共享开发配置：cordis 插件 tsdown 预设 + tsconfig（`packages/*/*` 复用） | [tsconfig](devpackages/devkit/tsconfig.json)                                                                                                      |
| `vendor/`                                                     | 上游 deepseek-harness side workspace（同步 / 裁剪 / 构建）              | [dsh-plugin-upstream-sync skill](.agents/skills/dsh-plugin-upstream-sync/SKILL.md)                                                                |

## 文档

| 文档                                                                   | 内容                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| [`.agents/README.md`](.agents/README.md)                               | 记录树布局与编号 / 引用规则                            |
| [`.agents/CONTEXT-MAP.md`](.agents/CONTEXT-MAP.md)                     | 上下文边界与全部包的归属                               |
| [`.agents/CONTEXT.md`](.agents/CONTEXT.md)                             | 会话编辑（跨包词汇）                                   |
| [`.agents/standards/`](.agents/standards)                              | 规范（如何写 / 如何验证）                              |
| [`.agents/designs/0001-系统设计.md`](.agents/designs/0001-系统设计.md) | 整体设计（布局 / 分层 / 装配 / 操作语义）              |
| [`.agents/adrs/`](.agents/adrs)                                        | 仓库级决策（上游 vendor 策略、workspace 链接、桌面化） |
| [`.agents/debts/`](.agents/debts)                                      | 技术债登记（上游对话 UI 接管等临时偏离与回退条件）     |
| [AGENTS.md](AGENTS.md)                                                 | agent 工作指引（home 表 + 红线）                       |
| [justfile](justfile) · [mise.toml](mise.toml)                          | 常用命令 · 技术栈与上游版本                            |

决策（ADR）按层存放：仓库级 [`.agents/adrs/`](.agents/adrs/)（上游 side workspace 版本锁定、workspace
跨 vendor 链接与 devkit、桌面化迁移），包层 `packages/<family>/<pkg>/.agents/adrs/`（契约 / 编排 /
实现 / 客户端基础 / 沙箱决策；装配决策在
[packages/session/better-session/.agents/adrs/](packages/session/better-session/.agents/adrs/)）。
编号在各层内唯一，跨层引用一律给相对链接（规则见 [`.agents/README.md`](.agents/README.md)）。
