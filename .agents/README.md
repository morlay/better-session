# .agents/

按层组织的记录树。唯一规则：**改动属于哪一层，就写那一层的 `.agents/`。**

## 布局

| 目录 / 文件         | 每层都可       |
| ------------------- | -------------- |
| `CONTEXT.md`        | 是             |
| `standards/`        | 是             |
| `designs/NNNN-*.md` | 是             |
| `adrs/NNNN-*.md`    | 是             |
| `debts/NNNN-*.md`   | 是             |
| `skills/`           | **只在仓库根** |

每个目录放什么、判据是什么，见仓库根 [`AGENTS.md`](../AGENTS.md) 的 home 表；命名与格式见
`dsh-plugin-design` 技能的 `templates/`。

当前分层：

- 仓库根 [`.agents/`](./)：跨包 / 跨层的事实（会话编辑词汇、规范、系统设计、仓库级决策与债）+ 全部技能；
- 包层 `.agents/`（每层就地记录自己的术语、规范、设计、决策与债）：
  `packages/session/session-branch`、`packages/session/session-rdb`、
  `packages/session/ui-conversation-message-actions`、`packages/session/better-session`、
  `packages/llm/llm-openai-compatible`、`packages/client/ui-primitives`、
  `packages/preset/dsh-preset`、`packages/sandbox/dsh-sandbox-local`、
  `packages/desktop/dsh-desktopify`。

哪个上下文归属哪些包、术语表的 home 在哪，见 [`CONTEXT-MAP.md`](./CONTEXT-MAP.md)。

## 编号与引用

- 编号在**各层内**唯一、不复用——根 `.agents/adrs/0001-…` 与某包 `.agents/adrs/0001-…` 是两份不同的决策。
- **同层**引用用短号（`ADR-0003`、`设计 0001`、`债务 0002`）：编号可解析到层内唯一文件。
- **跨层**引用一律给相对链接：
  `[ADR-0002](../packages/session/session-branch/.agents/adrs/0002-版本效果以ignorable事件原样落库.md)`。

## 规矩

- 判据、命名与格式只在 `dsh-plugin-design` 技能的 `templates/` 定义一次；这里和别处都不复述。
- 「什么事实写哪个 home」的表在仓库根 [`AGENTS.md`](../AGENTS.md)。
