# 迁移到上游 SessionHandle 模型

状态：被 ADR-20260917-跟随上游session-format-v3 取代（当前形态：`SessionPersistenceRdb`
实现上游 `SessionHandle` 五方法契约，测试复用上游 handle 契约）

## 背景

上游 `@deepseek-ai/dsh-session-persistence` 发生破坏性重构：
`PersistenceCoordinator` + `PersistenceBackend` 原语模型整体删除，替换为
**`SessionHandle` 模型**（`create`/`open`/`flush`/`stat`/`list` 五个抽象方法，
全部围绕 per-session handle 的 `read`/`append`/`flush`/`close`）。

本仓库的 `session-rdb`（RDB 持久化后端）、`session-branch`（rewind/fork 分支面）、
`ui-conversation-message-actions`（就地编辑）原本都耦合旧原语模型，需整体迁移。

## 决策

### 1. 完整迁移到 handle 模型

`SessionPersistenceRdb` 实现五个抽象方法，内部复用既有 SQL 存储原语
（`Backend`/`BackendTx`/`WriteGuard`），新增 `RdbSessionHandle` 实现
`SessionHandle` 契约：

- **create**：注册 pending（本进程可见、未 materialize），返回 write handle。
- **open**：read 不取所有权；write 原子 claim 单写者所有权（`RdbBackendTracker`）。
- **flush**：服务级屏障，drain 所有活跃 write handle。
- **stat/list**：pending + 存储行合并视图，revision 沿用 storeIdentity 派生 token。

### 2. rewind/fork 保留为 rdb 私有扩展（独立线）

上游 handle 模型是 append-only，无截断 / 删除 API，因此 rewind 与 fork 保留为
`SessionPersistenceRdb` 的私有能力（契约面落在 `@morlay/session-branch` 的
`SessionBranchProvider`），与 handle 模型解耦。实现机制（后端事务截断、live 会话的
游标与继承前缀对齐、保留前缀配平）见
[session-rdb 分支能力](../../../session-rdb/.agents/designs/20260917-分支能力.md) 与
[ADR-rewind绕过handle模型直接截断](../../../session-rdb/.agents/adrs/20260917-rewind绕过handle模型直接截断.md)。

### 3. live 写入路由

live 会话的事件由 rdb 侧的路由缓冲、批量 drain 落库——机制见
[session-rdb 写路径](../../../session-rdb/.agents/designs/20260917-写路径.md)。

### 4. 测试契约复用

`testing/contract.ts` 复用上游新版 handle 契约（`runPersistenceContract`）；
`testing/coordinator-contract.ts` 只留 RDB 特有行为（live 驱动持久化、seed 边界、
fork / resume、HMR drain、冲突拒绝、torn-tail）。

## 后果

- 持久化语义（原样存储、不补 closers、读取视图修复、格式迁移）的当前形态在
  session-rdb 的[设计总览](../../../session-rdb/.agents/designs/20260917-设计总览.md)
  与 [`.agents/adrs/`](../../../session-rdb/.agents/adrs) 里维护，本文件不再复述。
- `session-branch` 只需类型适配（`SessionPersistenceSnapshot` 等）；
  `ui-conversation-message-actions` 的写入经 handle 模型（`sessionPersistence.append`）。
