# DSH Plugin(s)

DeepSeek Harness Plugin 自用开发插件集合。
在不改变 `@deepseek-ai/*` 代码的前提下，进行自定义扩展。

## 项目

包按 `packages/<family>/<pkg>` 两层存放，family 即上下文分组；术语表与归属见
[`.agents/CONTEXT-MAP.md`](.agents/CONTEXT-MAP.md)。

| 包                                         | 职责                                                                                  | 文档                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **session**（会话编辑）                    |                                                                                       |                                                                      |
| `session/better-session/`                  | 聚合层：profile bundle（安装 / 使用 / 配置）                                          | [README](packages/session/better-session/README.md)                  |
| `session/session-branch/`                  | 契约层：分支 provider 抽象 + 版本树投影                                               | [README](packages/session/session-branch/README.md)                  |
| `session/session-rdb/`                     | 实现层：RDB 持久化 + 分支 provider + storages / 查询接管                              | [README](packages/session/session-rdb/README.md)                     |
| `session/ui-conversation-message-actions/` | 编排层：edit / retry / recall / fork 编排 + client UI 替换                            | [README](packages/session/ui-conversation-message-actions/README.md) |
| `session/ui-conversation/`                 | 上游对话外壳的**薄壳 fork**（只留我们改过的文件，其余 import 指向上游源码、构建内联） | [README](packages/session/ui-conversation/README.md)                 |
| `session/dsh-reference-injection/`         | skill 引用后注入（`skill:name` → `<skill_content>`）                                  | [README](packages/session/dsh-reference-injection/README.md)         |
| `session/ui-conversation-manager/`         | 「对话管理」全局面板页：已归档会话的搜索 / 取消归档 / 删除 / 导入为新会话             | [README](packages/session/ui-conversation-manager/README.md)         |
| **client**（浏览器半基础）                 |                                                                                       |                                                                      |
| `client/ui-primitives/`                    | CSS-in-JS 样式层 + 引用统一解析 / 渲染转换                                            | [README](packages/client/ui-primitives/README.md)                    |
| **llm**（LLM 适配）                        |                                                                                       |                                                                      |
| `llm/llm-openai-compatible/`               | OpenAI-compatible 多 provider 路由（可选组件）                                        | [README](packages/llm/llm-openai-compatible/README.md)               |
| **preset**（profile 预设）                 |                                                                                       |                                                                      |
| `preset/dsh-preset/`                       | 个人 profile bundle：生成标准 / ptc preset、声明 pi-ai 路由、沙箱规则                 | [README](packages/preset/dsh-preset/README.md)                       |
| `preset/dsh-prompt-reminder/`              | 精简 system prompt 被裁掉的小节降级为 `<system-reminder>` 用户消息                    | [README](packages/preset/dsh-prompt-reminder/README.md)              |
| **sandbox**（沙箱替换）                    |                                                                                       |                                                                      |
| `sandbox/dsh-sandbox-local/`               | 额外可写根 + 拒绝项（替换 `ctx.sandbox` / `ctx.fs`）                                  | [README](packages/sandbox/dsh-sandbox-local/README.md)               |
| **desktop**（桌面化）                      |                                                                                       |                                                                      |
| `desktop/dsh-desktopify/`                  | 桌面化打包工具（`dsh-desktopify` CLI：dev / bundle）                                  | [README](packages/desktop/dsh-desktopify/README.md)                  |
| **workspace**（非发布）                    |                                                                                       |                                                                      |
| `apps/dsh-custom-next/`                    | 示例工作区：web 模式（`dsh web`）与 desktop 模式（Electron 壳）                       | [justfile](apps/dsh-custom-next/justfile)                            |
| `devpackages/devkit/`                      | 共享开发配置：cordis 插件 tsdown 预设 + tsconfig（`packages/*/*` 复用）               | [tsconfig](devpackages/devkit/tsconfig.json)                         |
| `vendor/`                                  | 上游 deepseek-harness side workspace（同步 / 裁剪 / 构建）                            | [skill](.agents/skills/dsh-plugin-upstream-sync/SKILL.md)            |

## 文档

| 目录                                                                   | 内容                                     |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| [`.agents/`](.agents)                                                  | 记录树（布局 / 词汇 / 边界）             |
| [`.agents/standards/`](.agents/standards)                              | 规范（如何写 / 如何验证）                |
| [`.agents/designs/`](.agents/designs)                                  | 整体设计                                 |
| [`.agents/adrs/`](.agents/adrs) · [`.agents/debts/`](.agents/debts)    | 仓库级决策 · 技术债                      |
| [`.agents/skills/`](.agents/skills)                                    | 流程（上游同步 / 设计 / 实现）           |
| [AGENTS.md](AGENTS.md) · [justfile](justfile) · [mise.toml](mise.toml) | agent 工作指引 · 命令 · 技术栈与上游版本 |
