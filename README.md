# better-session

DeepSeek Harness 的**分支式会话编辑** monorepo：在不修改上游
`@deepseek-ai/*` 代码的前提下，为会话提供 **就地编辑 / 重试 / 分支**
（rewind / retry / fork）闭环——GUI 里直接编辑用户消息、重试任意回合，
重写**同一会话**（session id 不变），只有分支才派生新 id。

## 快速开始

### 1. 安装（发布后）

一个 bundle 包装齐全部依赖组件：

```sh
dsh plugin --profile web add "@morlay/better-session"
```

安装 `@morlay/better-session` 会自动带上子包（`@morlay/session-branch`、
`@morlay/session-rdb`、`@morlay/ui-conversation-message-actions`），并由
bundle 的 patch 自动装配：

- `ctx.sessionPersistence` ← RDB（SQLite / PostgreSQL）持久化后端
- `ctx.sessionBranch` ← rewind / fork 数据层
- `ctx.sessionEditor` ← edit / retry / fork 编排（HTTP：`/session-editor`）
- `conversation.chat.node` ← 渲染替换（user 消息行内编辑 / 重试按钮）

### 2. 使用

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

### 3. 配置（rdb）

`$DSH_HOME/settings.yaml`：

```yaml
session-rdb:
  type: sqlite # 或 postgres + connectionString
  path: /abs/path/to/sessions.sqlite
```

## 本地开发（monorepo）

```sh
just dep      # 安装依赖
just build    # 构建全部包（tsdown）
just test     # vitest（含 PostgreSQL 契约测试，需 TEST_PG_URL）
just lint     # oxlint
just dev      # build + setup-dsh + 启动 web（dsh --profile web，DSH_HOME=.dsh-store）
```

## 包一览

| 包                                        | 职责                                                                                       | 文档                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `@morlay/session-branch`                  | 契约层：`SessionBranchProvider` 抽象 + `SessionBranch` 服务 + 版本树投影                   | [README](packages/session-branch/README.md)                  |
| `@morlay/session-rdb`                     | 实现层：RDB 持久化（`PersistenceBackend`）+ 分支 provider（`SessionBranchProvider`）双服务 | [README](packages/session-rdb/README.md)                     |
| `@morlay/ui-conversation-message-actions` | 编排层 + UI：edit / retry / fork 编排 + `conversation.chat.node` 渲染替换                  | [README](packages/ui-conversation-message-actions/README.md) |
| `@morlay/better-session`                  | profile 聚合 bundle：装配以上全部 + 官方 web-app                                           | 本文件                                                       |

## 设计要点

- **不改上游代码**：全部在插件层实现。
- **就地编辑**：edit / retry / reroll 用 `rewind` 截断 + `append` 重写同一
  会话（session id 不变、版本树单根）；只有 `fork` 创建新 id。
- **`rewind` 支持 live 会话**：GUI 打开中的会话也能就地编辑（截断 RDB 与
  内存 log、同步 coordinator cursor、重置 agent 轮次游标）。
- **`ignorable` 版本效果**：分支版本事件不进 canonical log，非 branch 读者
  安全跳过。
