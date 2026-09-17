# AGENTS.md

better-session：DeepSeek Harness 的**分支式会话编辑** monorepo——在上游 `@deepseek-ai/*`
（vendor 锁定的完整源码）之上为会话提供就地编辑 / 重试 / 撤回 / 分支（rewind / retry / recall / fork）
闭环，按契约、编排、RDB 持久化、装配四层组织。

## 必读

- 技术栈 [mise.toml](./mise.toml)；命令 [justfile](./justfile)（`just --list`）
- 记录树与分层规则 [`.agents/README.md`](./.agents/README.md)
- 术语与上下文边界 [`.agents/CONTEXT-MAP.md`](./.agents/CONTEXT-MAP.md)
- 规范（如何写 / 如何验证）[`.agents/standards/`](./.agents/standards)
- 整体设计（布局 / 分层 / 装配 / 操作语义）[`.agents/designs/0001-系统设计.md`](./.agents/designs/0001-系统设计.md)

## 一个事实只有一个 home

写之前先找它现在在哪：**找到就改那一份，找不到才新建**；别处要用就链接过去，不复制、不换说法。
**就近**：改动属于哪一层，就写那一层的 `.agents/`。

| 事实类型                  | home                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| 词是什么意思              | 该层 `.agents/CONTEXT.md`（边界见 [`.agents/CONTEXT-MAP.md`](./.agents/CONTEXT-MAP.md)） |
| 规范（如何写 / 如何验证） | 该层 [`.agents/standards/`](./.agents/standards)                                         |
| 设计与取舍                | 该层 `.agents/designs/`                                                                  |
| 难逆的决策与理由          | 该层 `.agents/adrs/`                                                                     |
| 已知且被接受的债          | 该层 `.agents/debts/`                                                                    |
| 包 / 应用的门面与用法     | 该包的 `README.md`（一句话定位 + 用法 + 链接）                                           |
| 怎么做（流程）            | 仓库根 [`.agents/skills/`](./.agents/skills)（不分子域）                                 |

只读上游、依赖方向、发布纪律这些约束在各层规范里，这里不重复。

## 红线

- 上游 `@deepseek-ai/*` **不可修改**（`vendor/**` 与 node_modules 只读；扩展走 cordis
  插件层：plugin / patch bundle / settings namespace；本地 patch 是例外，见
  `dsh-plugin-upstream-sync` 技能）。
- **发布走 CI**：严禁本地私自 `pnpm publish`（包括用 `--registry` 指向 GitHub Packages 的发布）。
  版本 bump 提交后由 CI 发布；本地只构建验证。
