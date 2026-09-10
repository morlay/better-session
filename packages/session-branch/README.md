# @morlay/session-branch

分支式会话编辑的**契约层**：定义数据层分支原语 `SessionBranchProvider`
（rewind / forkFrom / readBranchPrefix）、高层服务 `SessionBranch`
（`ctx.sessionBranch`）与共享的版本树投影 `buildTimeline`。

## 与上游 `SessionHandle` 的关系

上游持久化模型是 `SessionHandle`（append-only：`create` / `open` / `append` /
`flush` / `stat` / `list`），没有显式回退原语；本包在其旁边定义**分支面**
provider，负责显式回退与闭合边界派生：

| 面     | 上游 `SessionHandle`                   | 本包 `SessionBranchProvider`                           |
| ------ | -------------------------------------- | ------------------------------------------------------ |
| 覆盖   | 持久读写（append-only）                | 显式回退 + 闭合边界派生（分支面）                      |
| 原语   | `create` / `open` / `append` / `flush` | `readBranchPrefix` / `forkFrom` / `rewind`             |
| 实现方 | JSONL / RDB 等                         | RDB 等（`@morlay/session-rdb` 同时实现两者，形成闭环） |

## Provider 抽象

```ts
interface SessionBranchProvider {
  readonly name: string;
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
- `rewind`：唯一的显式回退原语，事务整体提交或回滚；**支持 live 会话**
  （内存 log 截断 + 派生缓存复位 + handle cursor / 继承前缀对齐，详见
  `@morlay/session-rdb` 的 [docs/branch.md](../session-rdb/docs/branch.md)）。

## 版本树

`buildTimeline(snapshots, readOwnEvents, sessionId)` 从会话快照（header
lineage）+ 每会话自有后缀（`seq >= seedLength` 的 `session-branch/version`
事件）投影完整版本树。

> 版本效果事件携带 `ignorable: true`：非 branch 读者凭信封安全跳过，事件
> 本身原样落库——live 会话从内存 log 读到效果，cold 会话经读路径恢复效果
> 详情（见 [ADR 0003](./docs/adr/0003-版本效果以ignorable事件原样落库.md)）。
