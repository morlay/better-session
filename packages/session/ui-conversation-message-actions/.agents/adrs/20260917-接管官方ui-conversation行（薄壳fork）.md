# 接管官方 ui-conversation 行（薄壳 fork）

状态：已采纳

## 背景

对话 UI 的改造点全部落在组件内部，而插件面只有「整格 shadow keyed slot」：

- 用户气泡把 `content` 拍平成字符串（`vendor/deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.tsx:19-39`，`texts.join('')`），未知块退化成 `JsonBlock`；
- 思考块不走 Markdown（`.../chat/ReasoningRow.tsx:28-61`，摘要行 `replaceAll('**','')`），且上游**没有** reasoning 专属槽；
- 队列行与 composer 各自维护一套纯文本投影（`.../ui-conversation/src/client/queue/QueueDock.tsx`、`.../input/facade.ts`）；
- 上游 `/client` 不导出组件（只导出 `apply` / `inject` 与类型），没有 wrap 上游组件的机制。

即：**只写插件、不改上游**无法完成这次重构；而逐点 patch 上游组件会让每个改点变成一条需要长期重放的 patch
（`patches/steps.json` 只能落干净基线，上游同区域变动即中断 `just vendor prepare`）。

## 决策

在 `@morlay/better-session` 的 bundle patch 里把官方 `ui-conversation` 行 `disabled: true`，并 insert 我们的一对一
行 `@morlay/dsh-client-ui-conversation`（包内位置 `packages/session/ui-conversation`）。

**为什么是整包而不是只 client 半**：`disabled: true` 停的是**整条插件行**（host 半与 client 半同属一个 package 与
装配行）。`ui-conversation` 的 host 半注册对话设置段（`CONVERSATION_SETTINGS_NAMESPACE`），只 client 就会让命名空间
无人注册。因此 fork 面是整包，命名空间与 schema 保持同名同形。

**为什么是薄壳而不是整包复制**：整包复制的跟随成本随复制面线性上涨。薄壳只留我们**有意改过**的文件，其余上游文件
由保留文件里的相对 import 指向 vendor 源、构建期内联进 `dist/client.cjs`（保留清单见
[债务 20260917-临时接管上游对话UI的client半](../../../ui-conversation/.agents/debts/20260917-临时接管上游对话UI的client半.md)）。
代价是**上游 client 半源码进了同一个 TS program**，随之而来的硬约束（根 `tsconfig.json` 保持 `composite: false`、
合并接口只能有一份实例）见
[包层规范 how-to-write](../../../ui-conversation/.agents/standards/how-to-write.md)。

`ui-primitives` **不在接管范围**：它是平台 baseline 模块（`.../client/web/src/platform.ts` 的 `PLATFORM_MODULES`），
由前端种子提供，插件无法替换，因此我们的引用 chip 图标与外观由自己的包实现。

## 考虑过的选项

| 选项                                         | 代价                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 现状：只 shadow `user` / `steering` keyed 槽 | 改不了 reasoning（无槽）；改不了 composer / 队列与编辑器内部（都在组件里，无槽）                 |
| 逐点 patch 上游组件                          | 每个改点一条 patch；CI 每次 release 重跑 `just vendor prepare`；patch 只能落干净基线，冲突即中断 |
| **禁用官方行 + 薄壳 fork（选定）**           | 一次性分叉；需要维护「上游同步 + 同形声明」两项持续成本；换来组件内部的改造面，且随时可整行回退  |
| 向上游提特性请求                             | 周期不可控，且我们要的是产品级形态（引用 wire、块级保真）                                        |

## 后果

- **槽声明所有权转移**：slot 的 `children` 既是声明也是授权（`vendor/deepseek-harness/packages/client/AGENTS.md` 的
  Slot 纪律）。禁用官方行后，它声明的 22 个 target-neutral 槽（`main.conversation` … `conversation.input.model`）与
  渲染必须由我们的 `client/apply.ts` 同形承担；否则 `ui-attachment` / `ui-reference` / `ui-skill` / `ui-commands` /
  `ui-model-selection` / `ui-approval` / `ui-tool` / `ui-cordis` 等插件的 `slots.register` 会 fail loud。
- **client 模块表**：本包会 require 非 baseline 动态行（`ui-renderer` / `ui-locale` / `ui-session` 等），声明在
  `package.json` 的 `dsh.client`（`inject` + `platform`）；可解析性依赖行顺序，由装配面测试守护。
- **类型面不受影响**：其它插件对官方包的引用都是 `import type` 或 `declare module`，禁用 cordis 行只停掉运行时槽声明
  与渲染，包仍在依赖树里，类型增强照常生效。
- **跟随上游**：复制面记录 fork 基线（`DEEPSEEK_HARNESS_VERSION`，见 `mise.toml`）；同步冲突时保留我们的实现，
  「接管了什么、什么条件下回退」登记为技术债
  （[债务 20260917-临时接管上游对话UI的client半](../../../ui-conversation/.agents/debts/20260917-临时接管上游对话UI的client半.md)），
  不新增 fork 清单文件。
- **回滚**：把 `disabled: true` 改回、删掉 insert 行即可回到官方渲染（我们的包不写会话数据，切换不迁移数据）。

## 相关

- 分层与装配全貌：[设计 20260917-系统设计](../../../../../.agents/designs/20260917-系统设计.md)；
- 引用解析与渲染转换的取舍：[ADR 引用的统一解析与渲染转换](./20260917-引用的统一解析与渲染转换.md)；
- client 半重构的分层做法：[设计 对话UI重构](../designs/20260917-对话UI重构.md)。
