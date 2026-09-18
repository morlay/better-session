# 如何验证（薄壳 fork 包）

通用规则（证据矩阵、jsdom pragma、失败处理、发布纪律）见根[如何验证](../../../../../.agents/standards/how-to-verify.md)；
这里只写本包的落点与判据。

**保留的那部分由我们维护，就要按接缝测**——不能以「上游代码」为由留空白（保留清单与回退条件见
[债务 临时接管上游对话UI的client半](../debts/20260917-临时接管上游对话UI的client半.md)）。

## 保留文件的接缝

- **核心纯逻辑**（引用文本与 scoped slash 归一、队列文本）→ node 环境单测：
  `src/__tests__/reference-text.spec.ts`、`queue-text.spec.ts`。
- **输入 / 队列的组装面**（hub、输入外壳、队列行——依赖 DOM 事件与渲染）→ jsdom 组件测试：
  `src/__tests__/input-hub.spec.tsx`、`input-shell.spec.tsx`、`queue-dock.spec.tsx`。
- **剪贴板资源**（粘贴 / 拖入的资源归一）→ `src/__tests__/clipboard-resource.spec.ts`。
- **不单独测**：`.styles.ts` 样式表与 locale 数据表（机制由 `packages/client/ui-primitives` 的
  styling / token 测试覆盖）、纯类型与桶文件、**不再复制的上游文件**（它们就是上游实现）。

## 未覆盖（有明确原因）

- `client/apply.ts`（插件装配 + slots 注册）、`client/skeleton/*`（`ConversationRoot` /
  `ConversationSession` / `InputBar` 等）、`client/service.ts`（`ConversationController`）的
  **slot 装配面**需要 cordis client 运行时（slots 声明者 / 注册表、locale、renderer、sessions 面），
  而上游 client 半是浏览器模块工厂，node / jsdom 不可加载 →
  [债务 对话UI客户端半的装配面缺测试辅助](../../../ui-conversation-message-actions/.agents/debts/20260917-对话UI客户端半的装配面缺测试辅助.md)。
  动这些 `apply` / 装配面之前先看该债务的触发条件。
