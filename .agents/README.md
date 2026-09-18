# .agents/

按层组织的记录树。唯一规则：**改动属于哪一层，就写那一层的 `.agents/`。**

## 布局

| 目录 / 文件               | 每层都可       |
| ------------------------- | -------------- |
| `CONTEXT.md`              | 是             |
| `standards/`              | 是             |
| `designs/<YYYYMMDD>-*.md` | 是             |
| `adrs/<YYYYMMDD>-*.md`    | 是             |
| `debts/<YYYYMMDD>-*.md`   | 是             |
| `skills/`                 | **只在仓库根** |

每个目录放什么、判据是什么，见仓库根 [`AGENTS.md`](../AGENTS.md) 的 home 表；命名与格式见
`dsh-plugin-design` 技能的 `templates/`。

当前分层：

- 仓库根 [`.agents/`](./)：跨包 / 跨层的事实（会话编辑词汇、规范、系统设计、仓库级决策与债）+ 全部技能；
- 包层 `.agents/`：每层就地记录自己的术语、规范、设计、决策与债。

哪个上下文归属哪些包、术语表的 home 在哪，见 [`CONTEXT-MAP.md`](./CONTEXT-MAP.md)。

## 命名与引用

- **三类记录统一用日期前缀**：`designs|adrs|debts/<YYYYMMDD>-<slug>.md`。日期是该记录的采纳 / 创建日，
  slug 就是标题（不翻译、不改写、不缩写）；同一天多篇靠 slug 区分，因此没有序号。日期与 slug 在**各层内**
  独立——根 `.agents/debts/20260917-…` 与某包 `.agents/debts/20260917-…` 是两份不同的债。
- **同层**引用：写 `ADR-<slug>` / `设计 <slug>` / `债务 <slug>`（同层日期相同，省掉日期）——都能解析到层内
  唯一文件。
- **跨层**引用一律给相对链接：链接目标用完整文件名 `<YYYYMMDD>-<slug>.md`，链接文本写
  `ADR-<YYYYMMDD>-<slug>` / `设计 <YYYYMMDD>-<slug>` / `债务 <YYYYMMDD>-<slug>`，或一句能认出指向哪份记录的
  简短描述：
  `[ADR-20260917-版本效果以ignorable事件原样落库](../packages/session/session-branch/.agents/adrs/20260917-版本效果以ignorable事件原样落库.md)`。

## 规矩

- 判据、命名与格式只在 `dsh-plugin-design` 技能的 `templates/` 定义一次；这里和别处都不复述。
- 「什么事实写哪个 home」的表在仓库根 [`AGENTS.md`](../AGENTS.md)。
