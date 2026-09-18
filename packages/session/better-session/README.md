# @morlay/better-session

profile 聚合 bundle：一次性装配 `@morlay/session-branch`、
`@morlay/session-rdb`、`@morlay/ui-conversation-message-actions` 与对话外壳的
**薄壳 fork 行**（只留我们改过的文件，其余引用上游源码）到 DeepSeek Harness web profile，
提供 **就地编辑 / 重试 / 撤回 / 分支**（rewind / retry / recall / fork）闭环。

## 安装

```sh
dsh plugin --profile web add "@morlay/better-session"
```

安装自动带上全部子包（`@morlay/session-branch`、`@morlay/session-rdb`、
`@morlay/ui-conversation-message-actions`、`@morlay/dsh-client-ui-conversation`、
`@morlay/dsh-client-ui-primitives`），并由 bundle 的 patch
（`cordis.patch.yml`）自动装配：

- `ctx.sessionPersistence` ← RDB（SQLite / PostgreSQL）持久化后端
- `ctx.sessionBranch` ← rewind / fork 数据层
- `ctx.sessionEditor` ← edit / retry / recall / fork 编排
  （HTTP：`/session-editor`；宿主内嵌客户端走 `connection.fetch` 的 `/api/session-editor`）
- `conversation.chat.node` ← 渲染替换（user 消息行内编辑 / 重试按钮）
- `conversation.composer.dock` 的 `stats` 行 ← 覆盖注册（priority −1；承载修好的 token 口径）
- 官方对话 UI 行里只有 `ui-conversation` 换成本仓库的 fork 行；`ui-chat` 与 `ui-input-trigger` 保持官方行
- `ui-primitives-fork` ← css-in-js 样式层（styled / Token / 官方 token 消费），fork 外壳的样式基础
- `ctx.sessionProjectionCache` ← 投影 checkpoint（替换官方插件，落 rdb 语义表）
- `ctx.sessionQuery` ← 会话查询（替换官方 `session-query-sqlite`：精确读 / 过滤 /
  血缘复用上游基类，全文检索维持 disabled，不引入派生索引库）
- storage hub 的 `rdb` KV 后端 ← workspace 域落 rdb 语义表

同时禁用官方 `session-persistence-jsonl`、`storage-json`、
`session-projection-cache`、`session-query-sqlite` 与两条官方外发通路
（`session-telemetry-otel`、`session-log-deepseek`，默认部署零官方外发，需要时
删行恢复），并把 `storage-domain` 的 backend 路由为 `rdb`：`$DSH_HOME/storages`
不再产生文件，storages 数据与事件日志同库
（[ADR-20260917-接管storages到rdb语义表](../session-rdb/.agents/adrs/20260917-接管storages到rdb语义表.md)）。

装配面由 `src/__tests__/patch.spec.ts`（patch 行 ↔ 上游 bundle id）与
`src/__tests__/assembly.spec.ts`（patch ↔ 依赖 ↔ client 声明）守护；逐行以 [`cordis.patch.yml`](./cordis.patch.yml) 为准。

## 使用

装配后即可在 GUI 会话中：

- **编辑** user 消息 → 撤回该消息及其后内容到输入框（rewind，不重放），用户改后自行发送（带确认弹窗）
- **重试** 任意闭合回合 → 就地重放该回合输入（带确认弹窗）
- **分支**（fork）→ 从任意闭合边界派生**新会话**

也可以直接调用服务：

```ts
// 编排层（host）
await ctx.sessionEditor.retry({ action: "retry", sessionId, turn: 2, cascade: "truncate" });
// 数据层
await ctx.sessionBranch.rewind(sessionId, 5);
await ctx.sessionBranch.forkFrom(sourceId, { atSeq: 6, childSessionId });
```

## 配置（rdb）

默认配置为 SQLite（`$DSH_HOME/sessions/sessions.sqlite`）。在
`$DSH_HOME/settings.yaml` 覆盖 `session-rdb` namespace：

```yaml
session-rdb:
  type: sqlite # 或 postgres + connectionString
  path: /abs/path/to/sessions.sqlite
```

## 本地开发

本包是 monorepo（pnpm workspaces）的一员：命令入口见根
[justfile](../../../justfile)，约定见
[`.agents/standards/`](../../../.agents/standards/README.md)，架构见
[设计 20260917-系统设计](../../../.agents/designs/20260917-系统设计.md)。
