# @morlay/session-branch

分支式会话编辑的**契约层**：定义数据层分支原语 `SessionBranchProvider`
（rewind / forkFrom / readBranchPrefix）、高层服务 `SessionBranch`
（`ctx.sessionBranch`）与共享的版本树投影 `buildTimeline`。

## 与上游 `SessionPersistence` 的关系

| 面     | 上游 `PersistenceBackend`                     | 本包 `SessionBranchProvider`                           |
| ------ | --------------------------------------------- | ------------------------------------------------------ |
| 覆盖   | 持久读写 + 崩溃修复（append-only）            | 显式回退 + 闭合边界派生（分支面）                      |
| 原语   | `loadStored` / `appendBatch` / `commitRepair` | `readBranchPrefix` / `forkFrom` / `rewind`             |
| 实现方 | JSONL / RDB 等                                | RDB 等（`@morlay/session-rdb` 同时实现两者，形成闭环） |

## Provider 抽象

```ts
interface SessionBranchProvider {
  readBranchPrefix(id, atSeq?, mode?, signal?): Promise<BranchBoundary>;
  forkFrom(sourceId, options?, signal?): Promise<SessionId>;
  rewind(id, toBoundary, signal?): Promise<SessionPersistenceSnapshot>;
}
```

- `readBranchPrefix`：定位 `atSeq` 锚定的闭合 `turn/end` 边界并返回前缀；
  `mode: "after"`（包含目标轮，fork 语义）/ `"before"`（排除目标轮，编辑 /
  重掷 / 重试语义）。
- `forkFrom`：纯 append——新会话（`parentSession` / `seedLength`），seed =
  边界前缀 + `seedSuffix`，不触碰源会话。
- `rewind`：唯一改写事件 log 的操作，事务整体提交或回滚；**支持 live
  会话**（内存 log 截断 + 派生缓存复位 + coordinator cursor 同步，见
  `@morlay/session-rdb` 的 `SessionBranchRdbProvider`）。
- `syncLiveCursor(sessionId)`：编排层把 ignorable 版本效果 push 进 live log
  后（不发布、不进 write-behind 缓冲），用其对齐 coordinator cursor，避免
  后续 append 的 seq 校验错位（默认空实现，rdb 覆写）。

## 版本树

`buildTimeline(snapshots, readOwnEvents, sessionId)` 从会话快照（header
lineage）+ 每会话自有后缀（`seq >= seedLength` 的 `session-branch/version`
事件）投影完整版本树。

> 版本效果事件携带 `ignorable: true`（对核心可跳过、**不进 canonical log**），
> live 会话从内存 log 读到效果，cold 会话 timeline 只有 lineage 骨架。
