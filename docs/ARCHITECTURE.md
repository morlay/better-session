# 整体架构

分支式会话编辑 monorepo：在不修改上游 `@deepseek-ai/*` 代码的前提下，为
DeepSeek Harness 会话提供 **就地编辑 / 重试 / 分支**（rewind / retry /
fork）闭环——GUI 里直接编辑用户消息、重试任意回合，重写**同一会话**
（session id 不变），只有分支才派生新 id。领域术语见
[CONTEXT-MAP.md](../CONTEXT-MAP.md)（会话编辑 / LLM 适配两个上下文）。

## 仓库布局

```
.
├── CONTEXT-MAP.md               # 领域模型映射（术语表真源）
├── docs/
│   ├── adr/                     # 仓库级决策（上游 vendor 策略）
│   ├── ARCHITECTURE.md          # 本文档
│   └── CODING_GUIDELINE.md      # 项目约定
├── apps/
│   └── dsh-custom/              # 本地 GUI 应用壳（dsh-web-desktopify：dev / bundle）
├── packages/
│   ├── session-branch/          # 契约层 @morlay/session-branch（provider 抽象 + 版本树）
│   │   ├── CONTEXT.md           # 会话编辑上下文术语表
│   │   └── docs/adr/            # 契约 / 编排 / 实现决策
│   ├── ui-conversation-message-actions/  # 编排层 @morlay/ui-conversation-message-actions
│   ├── session-rdb/             # 实现层 @morlay/session-rdb（RDB 持久化 + branch provider 双服务）
│   ├── better-session/          # 聚合层 @morlay/better-session（装配决策 docs/adr/）
│   └── llm-openai-compatible/   # LLM 适配 @morlay/dsh-llm-openai-compatible（独立上下文）
├── vendor/
│   └── deepseek-harness/        # 上游 side workspace（独立 git 仓库，见 dsh-side-workspace-plugin-develop skill）
├── .agents/skills/dsh-side-workspace-plugin-develop/ # 上游同步与适配流程 skill
├── AGENTS.md                    # agent 工作指引（索引）
├── justfile                     # 常用命令
└── mise.toml                    # 工具链版本（node / pnpm / just）+ DEEPSEEK_HARNESS_VERSION
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

| 层     | 包                                        | 职责                                                                                                                    |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 契约层 | `@morlay/session-branch`                  | `SessionBranchProvider` 抽象（rewind / forkFrom / readBranchPrefix）+ `SessionBranch` 服务 + `buildTimeline` 版本树投影 |
| 编排层 | `@morlay/ui-conversation-message-actions` | `SessionEditor` 编排（edit / retry / fork 完整功能）+ client bundle（`conversation.chat.node` 渲染替换）                |
| 实现层 | `@morlay/session-rdb`                     | RDB 持久化（实现上游 `PersistenceBackend`）+ 分支 provider（实现 `SessionBranchProvider`），双服务闭环                  |
| 聚合   | `@morlay/better-session`                  | profile bundle：`cordis.patch.yml` 一次性装配以上全部到 web profile                                                    |

## 核心设计

- **`SessionBranchProvider` 是与上游 `PersistenceBackend` 平行的额外
  provider 抽象**：一个负责持久读写 + 崩溃修复（append-only），一个负责
  显式回退 + 闭合边界派生（分支面）。rdb 同时实现两者并自动注册
  `ctx.sessionBranch`，形成闭环（[ADR 0001](../packages/session-branch/docs/adr/0001-分支面作为与上游PersistenceBackend平行的provider抽象.md)）。
- **就地编辑**：edit / retry 用 `rewind` 截断 + `append` 重写同一会话
  （session id 不变、版本树单根）；只有 `fork` 创建新 id
  （[ADR 0002](../packages/session-branch/docs/adr/0002-就地编辑重写同一会话而非新建会话.md)）。
- **`rewind` 支持 live 会话**：GUI 打开中的会话也能就地编辑（截断 RDB 与
  内存 log、同步 coordinator cursor、重置 agent 轮次游标）
  （[ADR 0006](../packages/session-branch/docs/adr/0006-rewind绕过coordinator直接截断.md)）。
- **`ignorable` 版本效果**：分支版本事件不进 canonical log，非 branch 读者
  安全跳过（[ADR 0003](../packages/session-branch/docs/adr/0003-版本效果以ignorable事件进live-log而不落canonical-log.md)）。
- **配置经 settings 服务覆盖**：`$DSH_HOME/settings.yaml` 的 `session-rdb`
  namespace 覆盖 cordis 层 entry config（注册于 `ctx.settings`，
  见 `SessionPersistenceRdb.settingsNs`）
  （[ADR 0002](../packages/better-session/docs/adr/0002-配置经settings服务覆盖而非直接改cordis配置.md)）。

## 装配（`@morlay/better-session` bundle patch）

```
ctx.sessionPersistence  ← RDB（SQLite / PostgreSQL）持久化后端（替换官方 jsonl）
ctx.sessionBranch       ← rewind / fork 数据层
ctx.sessionEditor       ← edit / retry / fork 编排（HTTP：/session-editor）
conversation.chat.node  ← 渲染替换（user 消息行内编辑 / 重试按钮）
```

默认配置为 SQLite（`$DSH_HOME/sessions/sessions.sqlite`）；`session-rdb`
namespace 可覆盖为 PostgreSQL（`connectionString`）。官方
`session-persistence-jsonl` 被禁用（`disabled: true`）——rdb 替换的起因与
权衡见 [ADR 0001](../packages/better-session/docs/adr/0001-rdb替换官方jsonl持久化.md)。

## 操作语义

| 操作    | 路径                                                    | 会话 id |
| ------- | ------------------------------------------------------- | ------- |
| `edit`  | 编辑已落定文本块 → `rewind` 截断 → `append` 重写 → 重放 | 不变    |
| `retry` | 重放该回合输入（带确认弹窗）                            | 不变    |
| `fork`  | 从任意闭合边界派生新会话（纯 append，不触碰源会话）     | 新      |

## 与上游的关系

- 上游 `@deepseek-ai/*` 代码**不可修改**：node_modules 只读；扩展走 cordis
  插件层（plugin / patch bundle / settings namespace）。
- 上游源码以 side workspace 形式 vendor 到 `vendor/deepseek-harness/`
  （版本锁定完整代码，`DEEPSEEK_HARNESS_VERSION`），更新与适配流程见
  [dsh-side-workspace-plugin-develop skill](../.agents/skills/dsh-side-workspace-plugin-develop/SKILL.md) 与
  [ADR 0001](adr/0001-上游以side-workspace版本锁定完整代码而非发布版本.md)。

## 决策索引

| 级别 | 位置 | 决策 |
| ---- | ---- | ---- |
| 仓库级 | [docs/adr/](adr/) | 上游以 side workspace 版本锁定完整代码而非发布版本 |
| 装配级 | [packages/better-session/docs/adr/](../packages/better-session/docs/adr/) | rdb 替换官方 jsonl 持久化；配置经 settings 服务覆盖 |
| 上下文级 | [packages/session-branch/docs/adr/](../packages/session-branch/docs/adr/) | 分支面 provider 抽象；就地编辑；ignorable 版本效果；稠密坐标；事件实体全局化；rewind 直接截断；并发写入 fail loud；合成 closers；导出即修复；client bundle 单文件；agent 驱动重放 |
| 上下文级 | [packages/llm-openai-compatible/docs/adr/](../packages/llm-openai-compatible/docs/adr/) | 起因（pi-ai 参数不完整）；传输层复用 ai-sdk；dict 多路由；模型目录缺省为空；凭据服务解析；采样合并规则 |

## 深入阅读

- 领域模型：[CONTEXT-MAP.md](../CONTEXT-MAP.md)、
  [会话编辑术语表](../packages/session-branch/CONTEXT.md)、
  [LLM 适配术语表](../packages/llm-openai-compatible/CONTEXT.md)
- 契约层：[packages/session-branch/README.md](../packages/session-branch/README.md)
- 编排层：[packages/ui-conversation-message-actions/README.md](../packages/ui-conversation-message-actions/README.md)
- 实现层：[packages/session-rdb/README.md](../packages/session-rdb/README.md)、
  [packages/session-rdb/docs/design.md](../packages/session-rdb/docs/design.md)
- 聚合 bundle：[packages/better-session/README.md](../packages/better-session/README.md)
- LLM 适配：[packages/llm-openai-compatible/README.md](../packages/llm-openai-compatible/README.md)
