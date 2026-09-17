# 临时接管上游对话 UI 的 client 半

状态：未销账（三个上游 client 包整包 fork、由我们维护，官方三行在装配里被 `disabled: true` 禁用）

**现象**

复制上游三个 client 包到本仓库，并在 `@morlay/better-session` 的 bundle patch 里禁用官方对应行、
insert 我们的一对一行：

| 上游行 id          | 上游包                                     | 我们的包                              | 改动动机                                                                                |
| ------------------ | ------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `ui-conversation`  | `@deepseek-ai/dsh-client-ui-conversation`  | `@morlay/dsh-client-ui-conversation`  | composer 的草稿模型（块序列而非 `draft: string`）、队列行去掉 inline edit、逐块渲染入口 |
| `ui-chat`          | `@deepseek-ai/dsh-client-ui-chat`          | `@morlay/dsh-client-ui-chat`          | 用户气泡与 assistant 渲染（思考块 Markdown、资源引用 chip、文件卡片、未知块 fallback）  |
| `ui-input-trigger` | `@deepseek-ai/dsh-client-ui-input-trigger` | `@morlay/dsh-client-ui-input-trigger` | 引用域的 `appearance` / `ReferenceIconKind` 是封闭联合，无法表达 resource / snippet     |

`ui-primitives` **不在**接管范围：它是平台 baseline 模块（`vendor/deepseek-harness/packages/client/web/src/platform.ts:7-21`
的 `PLATFORM_MODULES`），由前端种子提供，插件无法替换——因此引用 chip 的图标与外观由我们自己的包实现，
不复用 `ReferenceIcon`。

落地形态：三个包**整包 fork**（host 半 + client 半），落在
`packages/session/ui-{conversation,chat,input-trigger}`，`src/` 尽量保持上游形态（差异见下）；
装配在 `packages/session/better-session/cordis.patch.yml`：官方三行 `disabled: true` + `insert`
三个 `*-fork` 行。

阶段 0 的双 face 类型门禁（`just types`、`tsconfig.client.json`、`dist/client-types`）与同形守卫
（当时用 `fork-parity` spec 比对 `ui-conversation` 的 `SlotMap` 声明形状）**都已删除**：fork 的
client 半现在与 host 侧同属根 `tsconfig.json` 单 program，类型检查由 `just lint` 的 oxlint
（`typeAware` / `typeCheck`）承担；我们**改动过**的 client 半由自己的 jsdom 测试守护
（`ui-conversation-message-actions` 的 `client-controller` / `chat-node-actions`，
`ui-conversation` 的引用与队列纯逻辑），整包逐字复制的部分不补测试（口径见
[如何验证](../standards/how-to-verify.md) 的「fork 包的口径」）。

当前差异点（引用从 XML 资源块改为「裸 URI + 解析与渲染分离」后，
见 [ADR-0007](../../packages/session/ui-conversation-message-actions/.agents/adrs/0007-引用的统一解析与渲染转换.md)）——
同步上游时这些文件要按「保留我们实现」处理：

| 包                                | 差异                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui-conversation`                 | `input/reference-text.ts`（插入形态归一为裸 URI）、`input/clipboard-resource.ts`（粘贴落裸 URI + `clipboardUriOf` 工作区相对化）、`input/facade.ts`（提交回上游路径、`insertReference` 走纯文本、`restoreDraft` 收窄、`deps.cwd`、`clipboardUri`）、`input/hub.ts`（scoped 事件归一 + `cwd` 注入）、`input/editor/keymap.ts`（粘贴决策）、`input/editor/{view-binding,runtime,span-map}.ts`（chip 插入路径删除）、`queue/QueueDock.tsx`（`ReferenceMarkdown` 渲染 + `queueTextOf`）、`queue/queue-text.ts`（新增） |
| `ui-chat`                         | `chat/MessageItem.tsx`（user / steering 气泡改 `ReferenceMarkdown`，删 `projectUserText`、referenceSummary 与 `MarkdownText` 直用）、`chat/token-format.ts`（**主动修的缺陷**：`formatCacheHitPercent` 在 `cacheReadTokens > promptTokens` 且四舍五入到 100% 时，未命中侧展开循环 `scaledDoubleGap` 恒为负 → 同步死循环冻结主线程；我们改为越界输入按全命中返回 `"100"`，正常区间与上游逐值一致）                                                                                                                  |
| `ui-input-trigger`                | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ui-conversation-message-actions` | `client/chat-node/MessageItem.tsx`（同上）、`client/controller.ts`（回填 raw markdown）                                                                                                                                                                                                                                                                                                                                                                                                                            |

已删除的自造实现（不再跟随上游）：`input/resource-block.ts`（XML 契约）、`input/prompt-blocks.ts`、
`input/draft-blocks.ts`、`ui-chat/src/client/chat/text-fragments.ts`。

不在接管范围的新包（解析、渲染转换与后注入的宿主）：
`@morlay/dsh-client-ui-primitives`（`reference.ts` 统一解析、`reference-markdown.tsx` 渲染转换、
`client/markdown-text.ts` 官方件转口、`client/markdown-labels.ts`）与
`@morlay/dsh-reference-injection`（skill 后注入）。

**影响**

- 上游 `/client` 不导出组件（如 `ui-chat/src/client/index.ts` 只导出 `apply` / `inject` 与类型），
  插件面只有「整格 shadow keyed slot」，没有 wrap 上游组件的机制；改点（气泡的块拍平、`ReasoningRow`、
  `QueueDock`、composer 提交路径）全在组件内部。
- 上游没有 reasoning 专属渲染槽，也没有内容块的渲染注册面；接管 `ui-chat` 才能改这些点。
- `ReferenceInsert.appearance?: 'session' | 'file' | 'folder'`（`.../ui-conversation/src/client/contract/draft-editor.ts:14-20`）
  与 `ReferenceIconKind = 'session' | 'file' | 'folder'`（`.../ui-primitives/src/ReferenceIcon.tsx:6-14`）
  都是封闭联合，我们的资源 / 代码片段引用域无法在不接管的情况下表达。
- 这三个包与上游同名能力的差异不再随上游升级自动收益：每次同步都要人工判定冲突并保留我们的实现；
  fork 面的 slot 装配缺口登记在[债务 0002](./0002-对话UI客户端半的装配面缺测试辅助.md)。

**触发条件**

- 每次同步上游（`just vendor prepare`）时都必须处理这三包的冲突（策略见下），此时是回退评估的时机；
- 上游具备下面四项能力中的任一项时，逐项评估回退（不必等三项齐全，按被替代的那一项回退）：
  1. **引用域可扩展**：`ReferenceInsert.appearance` 与引用图标词表改为 merge-extensible 或接受自定义字符串
     → 回退 `ui-input-trigger`；
  2. **内容块渲染可注册**：client 侧提供「按 ContentBlock 类型注册渲染器」的扩展面（含未知块 fallback 约定）
     → 回退 `ui-chat` 的渲染改造部分；
  3. **组件级替换**：提供 wrap 上游组件或 reasoning 等子区域的渲染槽 → 回退对应组件，不再整包接管；
  4. **composer / 队列开放结构化草稿**：`InputState` 暴露有序的「文本 / 引用 / 附件」块序列、队列行以
     `content` 而非 `preview` 渲染 → 回退 `ui-conversation` 的输入与队列部分。

**销账条件**

Done when：上面四项能力中至少一项被上游支持，且对应回退动作执行完（逐项销账，不要求三项齐全）：

- 删除 `packages/session/better-session/cordis.patch.yml` 里对应的 `disabled: true` 行与 insert 行；
- 删除对应 fork 包及其在 profile 依赖树中的声明；
- 把该 fork 期间产出的能力（引用的统一解析与渲染转换、逐块渲染器）改为经上游扩展面注册。

**不修的理由**

上游当前没有组件级扩展面（见「影响」的三条缺失能力），不接管就做不了就地编辑的用户可见入口；
现在回退等于丢掉逐块渲染与引用统一解析。代价只在上游同步时结算，可以承受。

## 冲突与回写

同步上游时与我们的改动冲突，**保留我们自己的实现**（不回退、不迁就上游当前形态），继续跟踪该处能力；
只有到「上游已支持」或「我们不再需要偏离」时才执行回退动作。

每次同步后按项回写状态（`仍冲突` / `上游已支持 → 待回退` / `已回退`），并注明当时的
`DEEPSEEK_HARNESS_VERSION`。回写粒度按上面的四项能力，不按文件。

## 基线

- fork 基线：`DEEPSEEK_HARNESS_VERSION`（见根 `mise.toml`）对应的上游提交（由 `just vendor sync` 检出）；
- 差异登记：**即本记录**——fork 包不另写 README 或「差异」小节；升级上游时按上面的冲突策略处理，
  结论回写到本记录（如某项能力上游已支持，则标记并执行回退动作）。
