# 上下文映射

本仓库是 DeepSeek Harness 的**插件集合** monorepo，包含三类插件：
会话编辑插件族、LLM 适配插件与沙箱替换插件。三者互不依赖，各自独立成上下文。
仓库级决策（上游 vendor 策略）见 [docs/adr/](./docs/adr/)。

## 上下文

- [会话编辑](./packages/session-branch/CONTEXT.md) — 为会话提供就地编辑 / 重试 / 撤回 / 分支（rewind / retry / recall / fork）闭环
- [LLM 适配](./packages/llm-openai-compatible/CONTEXT.md) — 为 OpenAI 兼容端点提供 LLM 适配器
- [可配置沙箱](./packages/sandbox/dsh-sandbox-local/README.md) — 替换 `ctx.sandbox` / `ctx.fs`，在官方语义之上追加额外可写根与拒绝项

## 关系

- **会话编辑 ↔ LLM 适配**：无依赖。两者都作为 cordis 插件装配进 DeepSeek Harness，但互不引用（会话编辑经 `agents` 服务 duck-typed 驱动重放，不经过 LLM 适配器）。
- **可配置沙箱 ↔ 其余两者**：无依赖。它只替换官方的进程沙箱与文件系统服务，不引用会话编辑或 LLM 适配。
- **会话编辑内部**：契约层 `@morlay/session-branch` → 编排层 `@morlay/ui-conversation-message-actions` → 实现层 `@morlay/session-rdb`；装配决策（禁用官方 jsonl、rdb 替换、settings 覆盖）归聚合层 `@morlay/better-session`（`cordis.patch.yml` + `docs/adr/`）。
- **仓库 → 上游**：`vendor/deepseek-harness/` 是上游按版本克隆的 side workspace（`DEEPSEEK_HARNESS_VERSION` 锁定），本仓库所有包经 `workspace:^` 解析到该固定版本源码（见 [docs/adr/0001](./docs/adr/0001-上游以side-workspace版本锁定完整代码而非发布版本.md)）。
