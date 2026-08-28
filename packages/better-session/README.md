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

本包是 monorepo（pnpm workspaces）的一员，命令入口见根 [justfile](../../justfile)：

```sh
just dep      # 安装依赖
just build    # 构建全部包（tsdown）
just test     # vitest（含 PostgreSQL 契约测试，需 TEST_PG_URL）
just lint     # oxlint
```

架构与约定见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 与
[docs/CODING_GUIDELINE.md](../../docs/CODING_GUIDELINE.md)。
