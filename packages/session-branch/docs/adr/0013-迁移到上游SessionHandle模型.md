# 0013-迁移到上游 SessionHandle 模型（0.1.3-alpha.2）

## 状态

已实施（2026-09）

## 背景

上游 `@deepseek-ai/dsh-session-persistence` 从 0.1.2-rc.1 到 0.1.3-alpha.2 发生
破坏性重构：`PersistenceCoordinator` + `PersistenceBackend` 原语模型整体删除，
替换为 **`SessionHandle` 模型**（`create`/`open`/`flush`/`stat`/`list` 五个
抽象方法，全部围绕 per-session handle 的 `read`/`append`/`flush`/`close`）。

本仓库的 `session-rdb`（RDB 持久化后端）、`session-branch`（rewind/fork 分支
面）、`ui-conversation-message-actions`（就地编辑）全部深度耦合旧模型，需整体
迁移。

## 决策

### 1. 完整迁移到 handle 模型

`SessionPersistenceRdb` 实现新版五个抽象方法，内部复用既有 SQL 存储原语
（`Backend`/`BackendTx`/`WriteGuard`），新增 `RdbSessionHandle` 实现
`SessionHandle` 契约：

- **create**：注册 pending（本进程可见、未 materialize），返回 write handle。
- **open**：read 不取所有权；write 原子 claim 单写者所有权（`RdbBackendTracker`）。
- **flush**：服务级屏障，drain 所有活跃 write handle。
- **stat/list**：pending + 存储行合并视图，revision 沿用 storeIdentity 派生 token。

### 2. rewind/fork 作为 RDB 私有扩展保留（独立线）

上游 handle 模型是 append-only，无截断/删除 API。本仓库的 rewind（就地编辑
核心卖点）保留为 `SessionPersistenceRdb` 私有能力：

- `internals()` 暴露 `backend`/`writeGuard` 与便捷方法面（测试与 branch 层用）。
- `SessionBranchRdbProvider` 的 rewind 直接经 `internals().backend.transaction`
  截断桥接行 + 收缩 seedLength + bump revision，与上游 handle 模型解耦。
- live 会话的 write handle 经 `tracker.writerOf()` 获取，rewind 后
  `resetAfterRewind()` 对齐 cursor 与继承前缀。

### 3. live 路由（session/event → 缓冲 → drain）

`installLiveRouting` 复刻旧版 coordinator 的 write path：

- `session/created` → `ensureLiveHandle`（create 或 adopt 已存储会话，落 seed）。
- `session/event` → 缓冲到活跃 write handle（`enqueueLive`，200ms 批量窗口）。
- `session/flush` → `drainLive` + `flush`（durability barrier）。
- `session/disposed` → 等 handle 就绪后 close（drain 剩余缓冲）。
- HMR：插件 apply 时对已存在 live 会话补种。

### 4. 语义变化（测试随之更新）

| 旧语义                                     | 新语义                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| load 补合成 closers（crash-repair）        | 持久化层原样返回存储事件；补 closers 由消费方（Session 恢复 / agent-loop resume）负责 |
| 全 delta 批次不 materialize、list 不可见   | 保持 pending（本进程可见），close 后保留（everAppended）                              |
| `assistant/message` 可带 `sourceEventSeqs` | v2 禁止（嵌入 stream）；replace 用 `user/message`                                     |
| `packChunkRuns`/`StorageRecord` 序列化     | `sessionFormatCatalog.encodeCurrentEvent`（format v2）                                |
| `expandProvenanceFromStorage`              | v2 codec 内建 seq-ranges 解码                                                         |

### 5. 测试契约复用

`testing/contract.ts` 重写为上游新版 handle 契约（`runPersistenceContract`），
`testing/coordinator-contract.ts` 精简为 RDB 特有行为（live 驱动持久化、seed
边界、fork/resume、HMR drain、冲突拒绝、torn-tail）。

### 6. 旧格式（v0/v1）历史数据读取转换

RDB 历史会话行可能携带 `f_version = 0/1`（旧格式：消息无 id、assistant/message
用 content/provenance 顶层字段、无 stream）。直接 `rowToMeta` 返回 version 0
的 header 会被上游校验拒绝（"session header version must be 2, got 0"）。

`readLog` 检测 `f_version < 2` 时走 `legacy.ts` 的转换链：

- 行重建为 v0/v1 物理记录（header 含 seedLength、事件行含 surfaceOp）。
- 经上游 `sessionFormatCatalog.createRestore`（strict recovery）迁移链
  v0→v1→v2 转成 v2 逻辑事件（补消息 id、旧 assistant 形状转 stream）。
- `load()` 便捷方法对旧格式会话返回转换后的 v2 header 与继承前缀。

转换是**读取时**的（视图转换，不落库），与「导出即修复」同哲学；迁移链拒绝
（格式损坏）时原样抛出，fail-closed。

### 7. 移除 remap 与过滤，回归干净存储层（原样存储）

上游 JSONL 写路径对 ignorable 事件**无过滤**（原样落库，v2 validation 只校验
值合法 + 未知类型可跳过）。本仓库自创的 `isPersistedEvent` 过滤（ignorable
不落库）与坐标 remap（`remapSurfaceOp`/`remapShadowedRange`/`remapShadowedSeqs`/
`buildSeqMap`）全部删除：

- **写路径**：`appendBatch` 原样落库，cursor 推进 batch.length，无过滤无重编号。
- **读路径**：`scanRows` 只做 torn-tail 检测与 seq gap 校验，不做坐标映射。
- **live 路由**：`drainBuffered` 只过滤已由 `ensureLiveHandle` 落库的 seed 前缀
  （上游 seq 空间与 handle cursor 同空间），不再过滤 delta/ignorable。

### 8. fData 存完整事件（含 ignorable 信封），schema 保持 v2

版本效果事件（`session-branch/version`，ignorable 信封）原样落库后，读回时
`validateStoredEvents` 会把未知类型（非 ignorable）当损坏拒绝。与 JSONL 一致
需保留 ignorable 标记——**不新增列**：`f_data` 存完整事件（type/seq/time/data/
ignorable 信封，与 JSONL 每行同构），读回时整体解析。`rowToEvent` 兼容旧 v2
库的纯 data 形状（判别完整事件四键）。schema 保持 v2（`SCHEMA_VERSION = 2`），
无 v2→v3 迁移。

**写路径 v2 校验（fail-closed）**：`appendBatch` 落库前经 `validateStoredEvents`
校验——未知类型（非 ignorable）与非法消息形状拒绝入库，新入库数据只能是 v2
形状。旧格式（v0/v1）数据只在读取时经 legacy 转换链动态转换，不落新库。

- `ui-conversation-message-actions`：live 路径的版本效果事件经 RDB write handle
  直接落库（带 ignorable 信封），不再「push 内存 log 不落库」；`syncLiveCursor`
  已删除（版本效果落库后 cursor 自然推进）。

## 影响

- `session-rdb`：index.ts 重写（handle 模型 + tracker + live 路由），
  log.ts/import.ts 适配 format v2，branch.ts 迁移到 internals 面。
- `session-branch`：类型适配（`SessionPersistenceSnapshot` 等）。
- `ui-conversation-message-actions`：`sessionPersistence.append` → handle 模型，
  `assistant/message` 补 `stream` 字段，`MessageText` 组件（上游已删）内联化。
- 测试：rdb.spec / branch.spec / import.spec / multi-instance / multi-session /
  inbox-repair / migrate / edit.spec 全部迁移到新模型语义。
