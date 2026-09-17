# 0006-复制上游对话 UI 的 client 半并禁用官方行

状态：已采纳

对话 UI 的改造点全部落在组件内部，而插件面只有「整格 shadow keyed slot」：

- 用户气泡把 `content` 拍平成字符串（`vendor/deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.tsx:19-39`，`texts.join('')`），未知块退化成 `JsonBlock`；
- 思考块不走 Markdown（`.../chat/ReasoningRow.tsx:28-61`，摘要行 `replaceAll('**','')`），且上游**没有** reasoning 专属槽；
- 队列行与 composer 各自维护一套纯文本投影（`.../ui-conversation/src/client/queue/QueueDock.tsx:196-217`、`.../input/facade.ts:597-644`）；
- 上游 `/client` 不导出组件（`.../ui-chat/src/client/index.ts` 只导出 `apply`/`inject` 与类型），没有 wrap 上游组件的机制。

即：**只写插件、不改上游**无法完成这次重构；而逐点 patch 上游组件会让每个改点变成一条需要长期重放的 patch（`patches/steps.json` 只能落干净基线，上游同区域变动即中断 `just vendor prepare`）。

## 决策

在本仓库按**上游包边界**分别复制三个包（**整包 fork：host 半 + client 半**），一个上游行对一个我们的包：

| 上游行 id          | 我们的包                              | 包内位置                            |
| ------------------ | ------------------------------------- | ----------------------------------- |
| `ui-conversation`  | `@morlay/dsh-client-ui-conversation`  | `packages/session/ui-conversation`  |
| `ui-chat`          | `@morlay/dsh-client-ui-chat`          | `packages/session/ui-chat`          |
| `ui-input-trigger` | `@morlay/dsh-client-ui-input-trigger` | `packages/session/ui-input-trigger` |

在 `@morlay/better-session` 的 bundle patch 里把上述官方三行 `disabled: true`，并 insert 我们的一对一行。

**为什么是整包而不是只 client 半**：`disabled: true` 停的是**整条插件行**（host 半与 client 半同属一个 package 与装配行）。`ui-conversation` 的 host 半注册对话设置段（`CONVERSATION_SETTINGS_NAMESPACE` 等）、`ui-chat` 的 host 半注册 Chat 设置段——只 client 就会让这些命名空间无人注册。因此 fork 面是整包，命名空间与 schema 保持同名同形。

**该分则分**：包边界与上游一致，装配与替换都是一对一——某个上游包后来支持了扩展面，就单独回退那一行，不必整体拆包。`ui-input-trigger` 被接管的原因：引用域的 `appearance` 与引用图标词表都是封闭联合（`.../ui-conversation/src/client/contract/draft-editor.ts:14-20` 的 `ReferenceInsert.appearance`、`.../ui-primitives/src/ReferenceIcon.tsx:6-14` 的 `ReferenceIconKind`），表达不了 resource / snippet。

`ui-primitives` **不在接管范围**：它是平台 baseline 模块（`.../client/web/src/platform.ts:7-21`），由前端种子提供，插件无法替换，因此我们的引用 chip 图标与外观由接管包自己实现。

## 落地记录（阶段 0）

> 阶段 0 的形态已被后续改动取代（类型 face 合并、同形守卫移除、引用改统一解析），
> 差异清单与回退状态见 [债务 0001](../../../../../.agents/debts/0001-临时接管上游对话UI的client半.md)。

- 三个包各自 `src/` 从上游复制（含 `css-modules.d.ts`、`*.module.css`、host 半的 settings 模块），包间引用（含类型与 `declare module`）统一改指我们的包名；
- patch 装配：`packages/session/better-session/cordis.patch.yml` 的 `disabled: true` 三行 + `insert` 三个 `*-fork` 行；包声明在 `better-session` 的 `dependencies`（由 `src/__tests__/assembly.spec.ts` 守护双向一致）；
- 同形守卫：阶段 0 用 `fork-parity` spec（比对 `ui-conversation` 的 `SlotMap` 声明形状）守形，随 client 测试设施落位后已移除；当前 fork 的差异点由 `packages/session/ui-conversation/src/__tests__/{reference-text,clipboard-resource,queue-text}.spec.ts` 与编排层测试守护；
- client 测试设施：根 `vitest.config.ts` 收 `.spec.tsx`，jsdom 经文件头 `// @vitest-environment jsdom` 启用（根 devDependencies 装 React 18 / testing-library 16 / jsdom，与上游 client 的 React 版本一致）；
- devkit 预设补齐两处（否则 fork 无法构建/运行）：`inputOptions.resolve.conditionNames`（按 NODE_ENV 选 production/development + browser，避免解析到 lexical 带 top-level await 的 node 变体）与 `import.meta.env(.MODE)` 替换；以及 **external 判定改为上游语义**——baseline 与 client 插件行走模块表，`dsh-file-reference` / `dsh-session` / `dsh-util-*` / `dsh-token-meter/client` / `schemastery` 这类「契约层」（模块表里没有条目）一律内联，否则 bundle 会 require 不存在的模块；
- 类型检查：fork 的 client 半与 host 侧同属根 `tsconfig.json` 单 program（`devpackages/devkit/tsconfig.json`），由 `just lint` 的 oxlint（`typeAware` + `typeCheck`）检查——阶段 0 的双 face（`just types` / `tsconfig.client.json` / `dist/client-types`）已删除；
- fork 源码没有 lint / fmt 豁免：`.oxlintrc.json` / `.oxfmtrc.json` 只忽略 `target` / `lib` / `**/dist/**`，fork 的 `src/**` 同样过 oxlint（含 typeCheck）与 oxfmt——要与上游保持可 diff 的形态时以 [债务 0001](../../../../../.agents/debts/0001-临时接管上游对话UI的client半.md) 的差异清单为准，不靠忽略豁免；
- 其它接入修正：`better-session` 的 patch 守卫 `patch.spec.ts` 期望清单同步三行禁用 + 三行 insert；三个 fork 的 `exports["./client"]` 带 `types` 条件（`./src/client/index.ts`）以支持 fork 间类型引用；
- 样式层：fork 包的 CSS Modules 将由 [`@morlay/dsh-client-ui-primitives`](../../../../client/ui-primitives/README.md)（css-in-js：`styled` + `dsw` 消费官方 `--dsw-*`）逐步替换，见该包 [ADR-0001](../../../../client/ui-primitives/.agents/adrs/0001-css-in-js样式层与官方token消费.md)；
- 运行验证：`dsh web` 启动无插件加载错误，页面模块清单里三个官方包均被我们的 fork 替换（各 1 条、官方 0 条），三个 `client.js` 均 200 可取；全量 `vitest`、`oxlint`（含类型检查）、`oxfmt` 全绿。

## 考虑过的选项

| 选项                                          | 代价                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现状：只 shadow `user` / `steering` keyed 槽  | 改不了 reasoning（无槽）；改不了 composer / 队列（在 ui-conversation 内部）；file 卡片已与上游分叉（`packages/session/ui-conversation-message-actions/src/client/chat-node/MessageItem.tsx:21-37` 缺 file 分支） |
| 逐点 patch 上游组件                           | 每个改点一条 patch（MessageItem、ReasoningRow、QueueDock、facade、queue-mirror…）；CI 每次 release 重跑 `just vendor prepare`；patch 只能落干净基线，冲突即中断                                                  |
| **按上游边界复制三个包 + 禁用官方行（选定）** | 一次性分叉；需要维护「上游同步 + 同形声明」两项持续成本；换来完全自由的改造面，且逐包可单独回退                                                                                                                  |
| 向上游提特性请求                              | 周期不可控，且我们要的是产品级形态（引用 wire、块级保真）                                                                                                                                                        |

## 后果

- **槽声明所有权转移**：slot 的 `children` 既是声明也是授权（`vendor/deepseek-harness/packages/client/AGENTS.md` 的 Slot 纪律）。禁用 `ui-conversation` 后，它声明的 22 个 target-neutral 槽（`main.conversation` … `conversation.input.model`，见 `.../ui-conversation/src/client/contract/slots.ts:117-188`）与 `ui-chat` 的 6 个消息槽（`.../ui-chat/src/client/contract/slots.ts:180-218`）必须由我们的包**原样声明**；否则 `ui-attachment` / `ui-reference` / `ui-skill` / `ui-commands` / `ui-model-selection` / `ui-approval` / `ui-tool` / `ui-cordis` 等插件的 `slots.register` 会 fail loud。
- **模块表**：我们的包会 require 非 baseline 动态行（`ui-renderer`、`ui-input-trigger`、`ui-locale`、`ui-session`…）。现有 bundle 未声明 `dsh.client.external`，可解析性依赖行顺序（`.../client/web/src/platform.ts:7-21` 的 baseline 只有 React / cordis / store / slots / primitives / dockkit）；复制后需要显式声明排序边并验证。
- **类型面不受影响**：其它插件对两个官方包的引用都是 `import type` 或 `declare module`（如 `ui-input-trigger/src/client/controller.ts:12-14`、`ui-trajectory/src/client/layout.ts:5-14`、`ui-goal/src/client/goal-command-input.ts:4-6`），禁用 cordis 行只停掉运行时槽声明与渲染，包仍在依赖树里，类型增强照常生效。
- **跟随上游**：复制面必须记录 fork 基线（`DEEPSEEK_HARNESS_VERSION`，见 `mise.toml`）与差异范围；升级时按三方合并处理。复制面越大跟随成本越高，因此复制范围要显式限定在 client 半，并把「接管了什么、什么条件下回退」登记为技术债（[债务 0001](../../../../../.agents/debts/0001-临时接管上游对话UI的client半.md)）。同步流程沿用既有机制（`patches/` + 债务记录），不新增 fork 清单文件。
- **冲突取舍**：同步上游时若与我们的改动冲突，**保留我们自己的实现**（不回退、不迁就上游的当前形态），继续跟踪上游该项能力；直到该处不再冲突（上游已支持，或我们已不再需要偏离）才按回退动作换回官方实现。每次同步后把结论（仍冲突 / 上游已支持）回写到债务记录。
- **测试设施**：client 测试设施已就位（根 `vitest.config.ts` 收 `packages/**/src/__tests__/**/*.spec.tsx`，jsdom + `@testing-library/react`）。我们**改动过**的 client 半（编排层 `controller` / `UserMessageNodeView` 门控、`ui-conversation` 的引用与队列纯逻辑）有 jsdom 守护；整包逐字复制的接管包不补行为测试——口径见 [规范「fork 包的口径」](../../../../../.agents/standards/how-to-verify.md)。
- **回滚**：把禁用三行改回、删掉对应 insert 行即可逐包回到官方渲染（我们的包不写会话数据，切换不迁移数据）。

## 落地记录

路线已确认（2026- 评审通过），分层方案见 [设计 0001](../designs/0001-对话UI重构.md)；接管本身登记为 [债务 0001](../../../../../.agents/debts/0001-临时接管上游对话UI的client半.md)。
