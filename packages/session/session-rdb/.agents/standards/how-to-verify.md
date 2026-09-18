# 如何验证（数据面）

通用规则（证据矩阵、失败处理、发布纪律）见根[如何验证](../../../../../.agents/standards/how-to-verify.md)；
这里只写本包的数据面接缝、环境门控与测试辅助。

## 接缝与守护 spec（`src/__tests__/`）

- **数据（provider）**：`ctx.sessionBranch`（`readBranchPrefix` / `forkFrom` / `rewind`）+
  `ctx.sessionPersistence`——持久化与分支数据面：`branch.spec.ts`、`rdb.spec.ts`、`deletion.spec.ts`、
  `import.spec.ts`。
- **分支语义的端到端用例**在 `branch.spec.ts`（真实 SQLite 后端 + coordinator 状态同步 + duck-typed
  agent 驱动）。
- 其余面各自成 spec：`write-guard`、`busy-timeout`、`multi-instance`、`multi-session`、
  `projection-cache`、`session-query`、`session-title`、`storage-takeover`、`migrate`、`inbox-repair`、
  `vendor-spec-alignment`。

## 环境门控

- 默认后端是 SQLite `:memory:`，无需外部服务。
- **PostgreSQL 契约测试**（`pg.spec.ts`）需要 `TEST_PG_URL`：本地用 `just pg test`（docker compose 起库
  并注入连接串），CI 由 postgres service 提供；未设置时 `describe.skipIf` 自动跳过。

## 测试辅助（`./testing`）

- `EmptySettings`：空 settings provider，满足插件的 `static inject: ['settings']`；
- **契约 fixture**：`contract.ts` 的 `runPersistenceContract` / `ContractBackend`、
  `coordinator-contract.ts` 的 `runCoordinatorContract` / `CoordinatorFixture`；
- 日志 fixture：`meta` / `oneTurnLog` / `appendLog`，以及 `truncateLiveSession`；
- 投影注册用上游 `new SessionProjectionRegistry(ctx)`（`@deepseek-ai/dsh-session-projection`）。
