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
│   └── dsh-custom-next/          # 示例工作区：web 模式（dsh web）与 desktop 模式（Electron 壳）
├── devpackages/
│   ├── devkit/                   # 共享开发配置（cordis 插件 tsdown 预设 + tsconfig）
│   └── dsh-desktopify/           # 桌面化打包工具（Electron 壳，dev 链接工作区 / bundle 静态打包）
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
| 实现层 | `@morlay/session-rdb`                     | RDB 持久化（实现上游 `SessionHandle` 模型）+ 分支 provider（实现 `SessionBranchProvider`），双服务闭环                  |
| 聚合   | `@morlay/better-session`                  | profile bundle：`cordis.patch.yml` 一次性装配以上全部到 web profile                                                     |

## 核心设计

- **`SessionBranchProvider` 是与上游 `SessionHandle` 平行的额外
  provider 抽象**：一个负责持久读写（append-only），一个负责
  显式回退 + 闭合边界派生（分支面）。rdb 同时实现两者并自动注册
  `ctx.sessionBranch`，形成闭环（[ADR 0001](../packages/session-branch/docs/adr/0001-分支面作为与上游SessionHandle平行的provider抽象.md)）。
- **就地编辑**：edit / retry 用 `rewind` 截断 + `append` 重写同一会话
  （session id 不变、版本树单根）；只有 `fork` 创建新 id
  （[ADR 0001](../packages/ui-conversation-message-actions/docs/adr/0001-就地编辑重写同一会话而非新建会话.md)）。
- **`rewind` 支持 live 会话**：GUI 打开中的会话也能就地编辑（截断 RDB 与
  内存 log、对齐 handle cursor、重置 agent 轮次游标）
  （[ADR 0003](../packages/session-rdb/docs/adr/0003-rewind绕过handle模型直接截断.md)）。
- **`ignorable` 版本效果**：分支版本事件原样落库（带 ignorable 信封），非
  branch 读者安全跳过（[ADR 0003](../packages/session-branch/docs/adr/0003-版本效果以ignorable事件原样落库.md)）。
- **配置经 settings 服务覆盖**：`$DSH_HOME/settings.yaml` 的 `session-rdb`
  namespace 覆盖 cordis 层 entry config（注册于 `ctx.settings`，
  见 `SessionPersistenceRdb.settingsNs`）
  （[ADR 0002](../packages/better-session/docs/adr/0002-配置经settings服务覆盖而非直接改cordis配置.md)）。

## 装配（`@morlay/better-session` bundle patch）

`cordis.patch.yml` 一次装配四层服务：持久化（RDB，替换官方 jsonl）、分支
数据、edit / retry / fork 编排、`conversation.chat.node` 渲染替换。装配链
与服务调用示例见
[packages/better-session/README.md](../packages/better-session/README.md)，
rdb 替换的起因与权衡见
[ADR 0001](../packages/better-session/docs/adr/0001-rdb替换官方jsonl持久化.md)。

默认配置为 SQLite（`$DSH_HOME/sessions/sessions.sqlite`）；`session-rdb`
namespace 可覆盖为 PostgreSQL（`connectionString`）；官方
`session-persistence-jsonl` 被禁用（`disabled: true`）。

## 操作语义

`edit` / `retry` / `reroll` 就地重写同一会话（`rewind` 截断 + `append`
重放，session id 不变），只有 `fork` 派生新 id。各操作的完整语义见
[packages/ui-conversation-message-actions/README.md](../packages/ui-conversation-message-actions/README.md)。

## 与上游的关系

- 上游 `@deepseek-ai/*` 不可修改（红线见 [AGENTS.md](../AGENTS.md)）：扩展走
  cordis 插件层（plugin / patch bundle / settings namespace）。
- 上游源码以 side workspace 形式 vendor 到 `vendor/deepseek-harness/`
  （版本锁定完整代码，`DEEPSEEK_HARNESS_VERSION`），更新与适配流程见
  [dsh-side-workspace-plugin-develop skill](../.agents/skills/dsh-side-workspace-plugin-develop/SKILL.md) 与
  [ADR 0001](adr/0001-上游以side-workspace版本锁定完整代码而非发布版本.md)。

## 桌面化（devpackages/dsh-desktopify）

`@morlay/dsh-desktopify` 把任意工作区打包 / 运行为桌面应用：Electron 壳
（`dsh-app://` 协议 + 上游 `dsh-desktop-host` 字节管道后端），`dev` 链接
工作区直接跑，`bundle` 产出静态、无签名的应用目录。工具形态（全 TS、
exports 收敛）、运行流程与运行时语义见
[devpackages/dsh-desktopify/README.md](../devpackages/dsh-desktopify/README.md)。

## 决策索引

| 级别     | 位置                                                                                                        | 决策                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库级   | [docs/adr/](adr/)                                                                                           | 上游 side workspace 版本锁定；workspace 跨 vendor 链接与 devkit 复用；桌面化迁移到 Electron + 上游 desktop-host                         |
| 装配级   | [packages/better-session/docs/adr/](../packages/better-session/docs/adr/)                                   | rdb 替换官方 jsonl 持久化；配置经 settings 服务覆盖                                                                                     |
| 上下文级 | [packages/session-branch/docs/adr/](../packages/session-branch/docs/adr/)                                   | 分支面 provider 抽象；ignorable 版本效果原样落库；迁移到上游 SessionHandle 模型                                                         |
| 上下文级 | [packages/session-rdb/docs/adr/](../packages/session-rdb/docs/adr/)                                         | 原样存储；事件实体全局化；rewind 直接截断；并发写入 fail loud；未闭合轮次原样保留；导出即修复；混合世代回退；跟随上游 Session format v3 |
| 上下文级 | [packages/ui-conversation-message-actions/docs/adr/](../packages/ui-conversation-message-actions/docs/adr/) | 就地编辑；client bundle 单文件；agent 驱动重放                                                                                          |
| 上下文级 | [packages/llm-openai-compatible/docs/adr/](../packages/llm-openai-compatible/docs/adr/)                     | 起因（pi-ai 参数不完整）；传输层复用 ai-sdk；dict 多路由；模型目录缺省为空；凭据服务解析；采样合并规则                                  |

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
- 桌面化：[devpackages/dsh-desktopify/README.md](../devpackages/dsh-desktopify/README.md)
