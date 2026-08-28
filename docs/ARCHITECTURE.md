# 整体架构

分支式会话编辑 monorepo：在不修改上游 `@deepseek-ai/*` 代码的前提下，为
DeepSeek Harness 会话提供 **就地编辑 / 重试 / 分支**（rewind / retry /
fork）闭环——GUI 里直接编辑用户消息、重试任意回合，重写**同一会话**
（session id 不变），只有分支才派生新 id。

## 仓库布局

```
.
├── apps/
│   └── dsh-custom/                 # 本地 GUI 应用壳（dsh-web-desktopify：dev / bundle）
├── packages/
│   ├── session-branch/             # 契约层 @morlay/session-branch（provider 抽象 + 版本树）
│   ├── ui-conversation-message-actions/  # 编排层 + UI @morlay/ui-conversation-message-actions
│   ├── session-rdb/                # 实现层 @morlay/session-rdb（RDB 持久化 + branch provider 双服务）
│   └── better-session/             # profile 聚合 bundle：装配以上全部
├── vendor/
│   └── deepseek-harness/           # 上游 side workspace（独立 git 仓库，见 vendor/README.md）
├── docs/                           # 本目录：架构与约定
├── AGENTS.md                       # agent 工作指引（索引）
├── justfile                        # 常用命令
└── mise.toml                       # 工具链版本（node / pnpm / just）+ DEEPSEEK_HARNESS_VERSION
```

## 分层模型

三层 cordis plugin，依赖单向向下：

```
契约层  @morlay/session-branch                provider 抽象 + 版本树投影
   ▲        ▲
   │        │
编排层  @morlay/ui-conversation-message-actions   SessionEditor 编排 + client UI（conversation.chat.node 替换）
   │        │
实现层  @morlay/session-rdb                  RDB 持久化 + branch provider 双服务
```

| 层       | 包                                        | 职责                                                                                       |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| 契约层   | `@morlay/session-branch`                  | `SessionBranchProvider` 抽象（rewind / forkFrom / readBranchPrefix）+ `SessionBranch` 服务 + `buildTimeline` 版本树投影 |
| 编排层   | `@morlay/ui-conversation-message-actions` | `SessionEditor` 编排（edit / retry / fork 完整功能）+ client bundle（`conversation.chat.node` 渲染替换） |
| 实现层   | `@morlay/session-rdb`                     | RDB 持久化（实现上游 `PersistenceBackend`）+ 分支 provider（实现 `SessionBranchProvider`），双服务闭环 |
| 聚合     | `@morlay/better-session`                  | profile bundle：`cordis.patch.yml` 一次性装配以上全部到 web profile |

## 核心设计

- **`SessionBranchProvider` 是与上游 `PersistenceBackend` 平行的额外
  provider 抽象**：一个负责持久读写 + 崩溃修复（append-only），一个负责
  显式回退 + 闭合边界派生（分支面）。rdb 同时实现两者并自动注册
  `ctx.sessionBranch`，形成闭环。
- **就地编辑**：edit / retry 用 `rewind` 截断 + `append` 重写同一会话
  （session id 不变、版本树单根）；只有 `fork` 创建新 id。
- **`rewind` 支持 live 会话**：GUI 打开中的会话也能就地编辑（截断 RDB 与
  内存 log、同步 coordinator cursor、重置 agent 轮次游标）。
- **`ignorable` 版本效果**：分支版本事件不进 canonical log，非 branch 读者
  安全跳过。
- **配置经 settings 服务覆盖**：`$DSH_HOME/settings.yaml` 的 `session-rdb`
  namespace 覆盖 cordis 层 entry config（注册于 `ctx.settings`，
  见 `SessionPersistenceRdb.settingsNs`）。

## 装配（`@morlay/better-session` bundle patch）

```
ctx.sessionPersistence  ← RDB（SQLite / PostgreSQL）持久化后端
ctx.sessionBranch       ← rewind / fork 数据层
ctx.sessionEditor       ← edit / retry / fork 编排（HTTP：/session-editor）
conversation.chat.node  ← 渲染替换（user 消息行内编辑 / 重试按钮）
```

默认配置为 SQLite（`$DSH_HOME/sessions/sessions.sqlite`）；`session-rdb`
namespace 可覆盖为 PostgreSQL（`connectionString`）。

## 操作语义

| 操作     | 路径                                                       | 会话 id |
| -------- | ---------------------------------------------------------- | ------- |
| `edit`   | 编辑已落定文本块 → `rewind` 截断 → `append` 重写 → 重放     | 不变    |
| `retry`  | 重放该回合输入（带确认弹窗）                               | 不变    |
| `fork`   | 从任意闭合边界派生新会话（纯 append，不触碰源会话）        | 新      |

## 与上游的关系

- 上游 `@deepseek-ai/*` 代码**不可修改**：node_modules 只读；扩展走 cordis
  插件层（plugin / patch bundle / settings namespace）。
- 上游源码以 side workspace 形式 vendor 到 `vendor/deepseek-harness/`，
  更新流程见 [vendor/README.md](../vendor/README.md)。

## 深入阅读

- 契约层：[packages/session-branch/README.md](../packages/session-branch/README.md)
- 编排层：[packages/ui-conversation-message-actions/README.md](../packages/ui-conversation-message-actions/README.md)
- 实现层：[packages/session-rdb/README.md](../packages/session-rdb/README.md)、
  [packages/session-rdb/docs/design.md](../packages/session-rdb/docs/design.md)
- 聚合 bundle：[packages/better-session/README.md](../packages/better-session/README.md)
