# 上下文地图

术语的唯一 home 是**它被理解的那一层**的 `.agents/CONTEXT.md`；这张表划边界，并在出现新语言边界时登记。

| 上下文                       | 术语表                                                                                                              | 边界                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话编辑（跨包）             | [`.agents/CONTEXT.md`](./CONTEXT.md)                                                                                | 为会话提供就地编辑 / 重试 / 撤回 / 分支（rewind / retry / recall / fork）闭环的共用词汇；契约层 `session/session-branch`、编排层 `session/ui-conversation-message-actions`、实现层 `session/session-rdb`、聚合层 `session/better-session`                                                                                                             |
| LLM 适配                     | [`packages/llm/llm-openai-compatible/.agents/CONTEXT.md`](../packages/llm/llm-openai-compatible/.agents/CONTEXT.md) | 为 OpenAI 兼容端点提供 LLM 适配器，只服务该包：`llm/llm-openai-compatible`                                                                                                                                                                                                                                                                            |
| 对话 UI 接管（技术债）       | —（无独立词汇）                                                                                                     | 上游对话 UI 的 client 半整包 fork 与其服务包：`session/ui-conversation`、`session/ui-chat`、`session/ui-input-trigger`（fork 三包）、`client/ui-primitives`（CSS-in-JS 样式层 + 引用统一解析 / 渲染转换）、`session/dsh-reference-injection`（skill 引用后注入）；动机、差异登记与回退条件见[债务 0001](./debts/0001-临时接管上游对话UI的client半.md) |
| profile 预设                 | —（无独立词汇）                                                                                                     | `preset/dsh-preset`（个人 profile 的装配与提示编排：生成 preset / 声明 pi-ai 路由 / 沙箱规则）、`preset/dsh-prompt-reminder`（被裁掉的 system prompt 小节降级为 `<system-reminder>`）                                                                                                                                                                 |
| 可配置沙箱                   | —（无独立词汇）                                                                                                     | `sandbox/dsh-sandbox-local`：替换 `ctx.sandbox` / `ctx.fs`，在官方语义之上追加额外可写根与拒绝项                                                                                                                                                                                                                                                      |
| 桌面化（工具，非插件上下文） | —（无独立词汇）                                                                                                     | `desktop/dsh-desktopify`：把任意工作区打包 / 运行为桌面应用（Electron 壳），决策见 [ADR-0003](./adrs/0003-桌面化从golang壳迁移到Electron与上游desktop-host.md)                                                                                                                                                                                        |

## 规则

- **词只定义一次**：两个以上包要用的词 → 根 `.agents/CONTEXT.md`；只在一个上下文里有意义的词 → 那个包
  `.agents/CONTEXT.md`。别处要用就链接过去，不复制定义、不换说法。
- `CONTEXT.md` **只放术语**：不放规范、不放设计理由、不放实现说明（各自的 home 见仓库根
  [`AGENTS.md`](../AGENTS.md) 的 home 表）。
- 出现新的语言边界（某个包开始有一套自己的词）就在表里加一行，并在那个包的 `.agents/` 下立
  `CONTEXT.md`；只有实现、没有自己语言的包不立。

## 关系

- **会话编辑 ↔ LLM 适配**：无依赖。两者都作为 cordis 插件装配进 DeepSeek Harness，但互不引用（会话编辑经
  `agents` 服务 duck-typed 驱动重放，不经过 LLM 适配器）。
- **可配置沙箱 ↔ 其余**：无依赖。它只替换官方的进程沙箱与文件系统服务。
- **会话编辑内部**：契约层 `@morlay/session-branch` → 编排层 `@morlay/ui-conversation-message-actions` →
  实现层 `@morlay/session-rdb`；装配决策（禁用官方 jsonl、rdb 替换、settings 覆盖）归聚合层
  `@morlay/better-session`（`cordis.patch.yml` +
  [ADR-0001](../packages/session/better-session/.agents/adrs/0001-rdb替换官方jsonl持久化.md)、
  [ADR-0002](../packages/session/better-session/.agents/adrs/0002-配置经settings服务覆盖而非直接改cordis配置.md)）。
- **对话 UI 接管 → 会话编辑**：`session/ui-*` 三个 fork 包与 `client/ui-primitives` 提供 client 半的渲染与输入基础，
  `session/ui-conversation-message-actions` 在其上替换 `conversation.chat.node` 的 `user` / `steering`
  渲染并挂编辑 / 重试入口；`session/dsh-reference-injection` 与 `preset/dsh-preset` 的装配行一起工作。
- **仓库 → 上游**：`vendor/deepseek-harness/` 是上游按版本克隆的 side workspace（`DEEPSEEK_HARNESS_VERSION`
  锁定），本仓库所有包经 `workspace:^` 解析到该固定版本源码（见
  [ADR-0001](./adrs/0001-上游以side-workspace版本锁定完整代码而非发布版本.md)）。

## 分层

`.agents/` 的目录布局与编号规则见 [`.agents/README.md`](./README.md)；这里只负责「哪个上下文在哪」。
