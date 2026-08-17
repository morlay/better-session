# 设计说明

本文件记录 `@morlay/session-rdb` 的设计与实现细节；使用方式见
[README](../README.md)。

## 仓库结构与依赖解析

本包位于 better-session monorepo 的 `packages/session-rdb/`，是三层
cordis plugin 的**实现层**：契约层 `@morlay/session-branch`（provider 抽象）→
本包（实现）→ 编排层 `@morlay/ui-conversation-message-actions`（完整 rewind/retry/fork 功能）。

```
packages/session-rdb/
├── cordis.patch.yml             # bundle 声明：dsh plugin 装配本插件
├── docs/design.md               # 本文档
├── package.json                 # 包元数据；exports 指向 lib/ 产物
├── src/                         # 只 import 官方包（@deepseek-ai/*）与 @morlay/session-branch
│   ├── __tests__/               # vitest 测试（testing/ 为共享契约与辅助）
│   ├── branch.ts                # 分支 provider 实现（rewind / forkFrom / timeline）
│   └── …                        # entities / adapters / 后端实现
├── tool/pg/                     # PostgreSQL 测试实例（compose + justfile）
└── README.md
```

## 与上游实现的差异

### 表结构：三表事件存储（参考 playpen-session store）

命名统一：表一律 `t_` 前缀、字段一律 `f_` 前缀；**实体在 `src/entities/`
纯定义**（每张表一个文件，方言无关的描述；无任何实现逻辑），SQLite
（`sqliteTable`）与 PostgreSQL（`pgTable`）的 drizzle 表对象以及建表 DDL
由 `src/adapters/` 从这些实体转化生成——无手写 DDL、无迁移工具链。另有
单例表 `t_persistence_state`（`f_singleton` / `f_store_id`，store 身份）与
PG 专用的 `t_schema_meta`。除键列外各表另带 `f_id` serial 自增主键
（`t_persistence_state` 以 `f_singleton`、`t_schema_meta` 以 `f_key` 为键列，
无 `f_id`）。**多表关联一律用业务键、不用 `f_id`**：`t_session_events` 的
`f_session_id` / `f_event_id` 外键（ON DELETE CASCADE）分别引用
`t_sessions.f_session_id` / `t_events.f_event_id`；查询与 join 也只走业务键
（`t_sessions`/`t_events` 按各自 UNIQUE 列，`t_session_events` 按
`UNIQUE(f_session_id, f_sequence)`），不为不可达查询维护额外索引。

| 表                 | 说明                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t_sessions`       | 会话元数据（`SessionHeader` 列）+ playpen 风格 head 游标（`f_head_event_id` / `f_head_sequence`，事务内维护，append 时提供 parent 链与下一个 seq）                                                                                                                                                                                                                               |
| `t_events`         | **全局事件实体**：`f_event_id`（UUID 唯一）、`f_parent_id`（事件链，空串表示 root）、`f_kind`（= 上游 `type`）、`f_role` / `f_name` / `f_action_id`（playpen 事件维度，从事件分类提取）、`f_encoding`（`json`）、`f_data`（JSON 文本）、`f_created_at`（= `time`）、`f_original_seq`（上游原始 seq）、`f_source_event_seqs` / `f_surface_op`（surface 元数据，JSON 文本或 NULL） |
| `t_session_events` | 会话事件桥接表：`(f_session_id, f_event_id, f_sequence)`，`UNIQUE(f_session_id, f_sequence)`，按 `f_sequence` 排序读取；删除尾部只删桥接行，事件作为全局实体保留                                                                                                                                                                                                                 |

`f_role` / `f_name` / `f_action_id` 映射：`turn/*`/`step/*`/`session/end-seed` → `turn`；
`user/message`/`steering/message`/`request/*` → `user`；`assistant/message` → `model`；
`tool/call` → `function` + `f_name=name` + `f_action_id=callId`；`tool/result` → `function`

- `f_action_id=message.content[0].toolCallId`；`todo/write` → `state` + `f_name=todos`；
  未知（插件扩展）事件类型保持 playpen 默认空值。

### delta 内容不入库（`assistant/chunk` 被过滤）

`EPHEMERAL_EVENT_TYPES = ['assistant/chunk']`：写入时 delta 事件**整行丢弃**（内容与
行都不落库），非 delta 事件按持久化计数**压缩重编号**（`f_sequence` 稠密连续，
`f_original_seq` 保留上游 seq）。读取时 `sourceEventSeqs` 经 `buildSeqMap` 重映射回稠密
seq 空间。由此：

- 库内 seq 始终连续，`scanRows` 的崩溃尾部语义（last `turn/end` 切割、torn tail 截断）不变；
- reload 后以 `load` 结果重建会话（`ctx.sessions.create(id, { seed })`），seed 稠密连续，
  后续 append 从稠密 cursor 继续——持久化侧"重新创建"了自己的 seq 体系，不依赖上游
  修改 session 层（上游 `Session.seq = log.length` 仍含 chunk）；
- 只含 delta 的批次是 no-op：不建行、不 bump revision；
- 契约测试（`runPersistenceContract` / `runCoordinatorContract`）不含 delta 事件，原样通过。

**`sourceEventSeqs` 写路径清理**：上游 `assistant/message` 的 `sourceEventSeqs` 引用的是
**上游 seq**（`agent-loop` 用产生该消息的 chunk seq 列表填充）。被过滤的 chunk 没有持久化
行，若原样落库，读取时 `buildSeqMap` 无法重映射这些引用（map 里没有对应项），重放 seed
时 `assertProvenance` 会报 `sourceEventSeqs must reference earlier events`（引用值 ≥ 当前
稠密 seq），会话显示损坏。因此写路径（`appendBatch`）按 session 记录被丢弃的 delta 上游
seq，写 `assistant/message` 时把 `sourceEventSeqs` 中命中这些 seq 的引用**剔除**（同批与
跨批都生效；剔除后为空则存 NULL，即无 provenance）。引用持久化事件（user/message、
tool/call 等）的部分原样保留并在读取时重映射。

已知代价：同一会话的库内 seq 与上游内存 seq 不同（差一个已过滤的 delta 计数）；上游
未来按提案给 chunk 分配独立通道（不占 seq）后，两套 seq 将自然合一。

**compact 计量事件的 `shadowedRange` 读取时重映射**：`compaction/summary` /
`compaction/prune` 事件在 `data.shadowedRange` 里携带 token-meter 的 shadow-price
claim（被紧随其后的 surface `replace` 覆盖的节点范围，按上游 seq 命名）。写路径原样
落库（引用的全是已持久化的 surface 节点，不会被 delta 过滤，无需剔除）；读取时
`rowToEvent` 经 `remapShadowedRange` 把它与 `replace` 的 `surfaceOp` 一样重映射回稠密
seq 空间——否则 claim（上游空间）与 replace 范围（稠密空间）不一致，token-meter 折叠
会以 `token surface: replace ... has no adjacent shadow price` 拒绝重放（历史加载失败）。

### 并发写入者检测（多个实例/进程共享同一数据库）

本后端的事件按**稠密 seq** 重编号（delta 过滤后），而每个
`PersistenceCoordinator` 实例只在内存里维护自己的**上游 seq** 游标。因此两个
后端实例（另一个 `dsh` 进程、或同一进程内重复加载的持久化插件）共享同一
`sessions.sqlite` 时，**同一个 session id 只能有一个写入者**：

- 后端记录每个 session「本实例最后确认的稠密 head」（来自本实例的写入或
  `loadStored` 观察）；`appendBatch` 在事务内校验磁盘 head 与该记录一致。
- 磁盘 head 已被其他实例推进（另一写入者提交过）、或本实例从未读过该 session
  却遇到已有行时，append **fail loud 拒绝**（`modified by another writer` /
  `has a persisted log this instance has not read`），而不是把本批次静默重编号到
  对方尾部——后者会把两组独立 turn 拼接成同一个 log，**事件内容与 seq 语义
  全部错位**（log 级损坏，`UNIQUE(f_session_id, f_sequence)` 无法拦截，因为
  稠密重编号天然无冲突）。
- 不同 session id 的并发写不受影响（各自独立 head），两个实例各写各的 session
  是受支持的多进程部署（`busy_timeout` 只负责让写锁竞争排队）。
- 一个实例 `load`（或 HMR adopt）过某 session 后可以继续 append——那是一次
  明确授权、基于最新磁盘状态的续接；同 id 双实例「都 load 过再各自写」仍不
  支持（需要跨实例协调器，超出本后端职责）。

### 其余保留的上游语义

- `t_persistence_state`（f_store_id 单例）、`SCHEMA_VERSION`（新实现从 1 起）、
  `application_id = 0x44534850`、`openDatabase` 的 BEGIN IMMEDIATE 校验
  （unversioned / 版本不匹配 / 外来 application id 拒绝且不迁移）
- 懒实体化（t_sessions 行 = materialized 信号）、崩溃尾部 on-load 修复（torn tail 截断 +
  合成 closers，head 游标同步回退/前进）、revision/incarnation 快照语义、
  文件与目录 owner-only 权限（0o600 / 0o700）、WAL 默认 `journal_mode`、
  `locate()` 返回 `undefined`（无独立 per-session 文件）

### 方言差异（PostgreSQL 后端）

- `f_created_at` 用 `BIGINT`（毫秒时间戳超出 PG `INTEGER` 的 int32 范围）；
- schema 版本 / 应用身份校验用 `t_schema_meta` 键值表（`schema_version` /
  `application_id` 两行），替代 SQLite 的 `PRAGMA user_version` /
  `application_id`（PG 无等价 pragma）；无迁移工具链，版本不匹配同样拒绝而非迁移；
- 事务：SQLite `BEGIN IMMEDIATE` 提前取写锁（busy_timeout 排队，进程内事务
  全局串行）；PG 依赖事务行锁 + `UNIQUE(f_session_id, f_sequence)` 拒绝冲突批次。

## 伴随插件（invariant）

`./invariant` 子路径导出伴随插件（`src/invariant.ts`）：在 `ctx.invariants` 服务上
以 `@morlay/session-rdb` 注册包所有权（当前安装器为空实现——持久化
正确性依赖后端往返与崩溃尾部测试，无可观测的进程内不变量）。

## 分支能力（`SessionBranchProvider` 的 rdb 实现）

本包在既有 `PersistenceBackend`（append-only 面）之上实现
`@morlay/session-branch` 的 `SessionBranchProvider`（分支面：rewind / forkFrom /
readBranchPrefix），并在插件构造时自动注册 `ctx.sessionBranch`
（`SessionBranchRdb`）——同一数据库连接、同一 coordinator 写路径，形成
rewind / retry / fork 的持久化闭环。

### forkFrom：纯 append，走标准 coordinator 路径

- 读源会话（`inspect`）→ `locateTurnEnd` 定位闭合边界（`after` 包含目标轮 /
  `before` 排除目标轮）→ 取前缀；
- 前缀按**新会话 log 保序重编号**（`map((e, i) => ({ ...e, seq: i }))`）——
  `sourceEventSeqs` 的相对序不变（引用总是更早事件），`source < seq` 校验成立；
- `create(childMeta)` + `append(childId, seed)` 走上游 coordinator——派生是
  纯 append（新 id / `parentSession` / `seedLength`），不触碰源会话；
- `seedSuffix`（版本效果事件等）按调用方构造追加；携带 `ignorable: true` 的
  版本效果事件按语义**不进 canonical log**（rdb `isPersistedEvent` 丢弃），
  live 会话的内存 log 保留、cold timeline 只有 lineage 骨架。

### rewind：绕过 coordinator 的直接截断 + 状态同步

上游 `PersistenceCoordinator` 只有 append-only + torn-tail 修复（`commitRepair`），
没有显式回退原语。rewind 直接操作后端事务：

1. **独占校验**：无 live owner（`ctx.sessions.get(id) === undefined`），否则
   `REWIND_CONFLICT`；prepared reservation 无法公开查询，靠 revision 变化
   自然失效；
2. **边界校验**：`toBoundary` 是已存在事件且为闭合 `turn/end`（或 `-1` 空前缀）；
3. **事务内截断**：`deleteBridgeTail(toBoundary + 1)` + head 游标回退（
   `getPrevBridge` 或初始 `-1`）+ `bumpRevision`——与 `commitRepair` 的事务
   模式同构，Abort 整体回滚；
4. **同步 coordinator 状态**：rewind 后 `load(id)`——revision 变化使
   `isPreparedSourceCurrent` 失效 → 重新 adopt → `state.cursor` 与新尾部一致；
   截断到闭合 turn/end 后 log 平衡，load 的 repair 为 no-op；
5. **更新 `WriteGuard` 确认 head**：下一次 append 的并发写入者校验以截断后
   head 为基准。

已知限制：rewind 是 rdb 特有的直接截断，未与 coordinator 的 per-id 串行链互斥
（无法从外部访问）；文档要求对 cold 会话调用（无 live owner、无 in-flight
append）。多实例共享数据库时 rewind 与并发 append 的交错由事务 + head 校验兜底。

### timeline：版本树投影

`parentSession` + `seedLength` 构成 lineage 骨架（header 字段，现有表无需改动）；
live 会话从内存 log 读自有后缀（含 `session-branch/version` 效果事件），cold
会话走 `readFrom`（效果不落 canonical log → 无效果详情，仅骨架）。
