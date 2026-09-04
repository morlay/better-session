# 0001-分支面作为与上游 PersistenceBackend 平行的 provider 抽象

上游 `PersistenceBackend` 只有 append-only 面（`loadStored` / `appendBatch` /
`commitRepair`），没有显式回退与闭合边界派生原语，且上游 `@deepseek-ai/*`
代码不可修改（node_modules 只读，扩展走 cordis 插件层）。我们新增平行的
`SessionBranchProvider` 抽象（`readBranchPrefix` / `forkFrom` / `rewind`），
由 `@morlay/session-rdb` 同时实现两个 provider 并自动注册 `ctx.sessionBranch`，
形成闭环——一个负责持久读写 + 崩溃修复，一个负责显式回退 + 闭合边界派生。

## 考虑过的选项

- **扩展上游 `PersistenceBackend` 接口**：违反「上游不可修改」红线。
- **编排层直接操作 rdb 后端**：契约层缺失，编排层与实现层耦合，无法替换实现。

## 后果

- 任何实现 `SessionBranchProvider` 的后端都可接入编排层，不限于 rdb。
- 两个 provider 共享同一数据库连接与 coordinator 写路径，无第二套状态。
