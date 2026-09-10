# @morlay/better-session

profile 聚合 bundle：一次性装配 `@morlay/session-branch`、
`@morlay/session-rdb`、`@morlay/ui-conversation-message-actions` 到
DeepSeek Harness web profile，提供 **就地编辑 / 重试 / 分支**
（rewind / retry / fork）闭环。

## 安装

```sh
dsh plugin --profile web add "@morlay/better-session"
```

安装自动带上子包（`@morlay/session-branch`、`@morlay/session-rdb`、
`@morlay/ui-conversation-message-actions`），并由 bundle 的 patch
（`cordis.patch.yml`）自动装配：

- `ctx.sessionPersistence` ← RDB（SQLite / PostgreSQL）持久化后端
- `ctx.sessionBranch` ← rewind / fork 数据层
- `ctx.sessionEditor` ← edit / retry / fork 编排（HTTP：`/session-editor`）
- `conversation.chat.node` ← 渲染替换（user 消息行内编辑 / 重试按钮）
- `ctx.sessionProjectionCache` ← 投影 checkpoint（替换官方插件，落 rdb 语义表）
- storage hub 的 `rdb` KV 后端 ← workspace 域落 rdb 语义表

同时禁用官方 `session-persistence-jsonl`、`storage-json` 与
`session-projection-cache`，并把 `storage-domain` 的 backend 路由为 `rdb`：
`$DSH_HOME/storages` 不再产生文件，storages 数据与事件日志同库
（[ADR 0009](../session-rdb/docs/adr/0009-接管storages到rdb语义表.md)）。

## 使用

装配后即可在 GUI 会话中：

- **编辑** user 消息 → 就地重写并重放（重新生成回复）
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
[justfile](../../justfile)，约定见
[docs/CODING_GUIDELINE.md](../../docs/CODING_GUIDELINE.md)，架构见
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。
