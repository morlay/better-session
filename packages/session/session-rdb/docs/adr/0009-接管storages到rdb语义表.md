# 0009 接管 storages 到 rdb 语义表

## 背景

`$DSH_HOME/storages` 由官方 storage 栈产出：`storage-json` 介质 +
`storage-domain` 域层，当前有两个域——

- `session_projcache`（v7，per-record）：`session-projection-cache` 插件的投影
  checkpoint，是**派生缓存**（miss 只会退化为更长的日志尾重放）；
- `workspace`（v2，single）：`ctx.workspaceRegistry` 的**权威数据**（记录顺序、
  显示顺序、归档集都不可从会话日志推导）。

本包已经用 RDB 接管了会话日志与分支能力，只剩这两份数据还在文件层：
SQLite 场景下它们是同一份状态的两个介质，PostgreSQL 场景下更是本地文件与
共享库不一致（多实例各写各的 `workspace.json`）。此外 `workspace` 是 single
布局，任一会话 attach/detach 都会原子重写整个 19KB 文档。

## 决策

1. **投影缓存服务级替换**：禁用官方 `session-projection-cache` 插件，由本包
   提供同名 `ctx.sessionProjectionCache` 服务（`packages/session-rdb/src/storage-takeover/projection-cache.ts`），
   公开面与语义逐一对齐上游（`cachedSnapshot` / `cachedPredecessorTitle` /
   `hydratePrepared` / `write` / `coldSnapshot`，三个强制写点 + 计数/定时节流，
   identity 校验与 `asOfSeq` 取最低水位）。checkpoint 只落**行级表**
   `t_session_projcache_row`（每个投影 key 一行，`f_ver`/`f_seq`/`f_val`）；
   日志 identity 与会话行 1:1，直接复用 `t_sessions` 的 `f_version` /
   `f_created_at` / `f_cwd` / `f_seed_length`，不另存记录头。
   - 读方法是同步签名（session 列表在请求路径上直接调用）：**SQLite 直读表**
     （`readProjcacheSync`，启动不做全表加载、外部写入立即可见）；PostgreSQL
     驱动异步，只有该后端保留写穿镜像来支撑同一签名。
2. **workspace 域只换介质**：保留官方 `workspace` 插件（registry 行为零漂移），
   由本包在 storage hub 注册 `rdb` KV 后端（`src/storage-takeover/storage-backend.ts`），
   实现上游 `StorageBackend.kv` / `KvUnit` 契约并把域映射到语义表。
   `storage-domain` 的 backend 路由改为 `rdb`。KV 这层名字来自上游
   storage-domain 的扩展点，不是本包引入的概念。
3. **状态即数据**：上游把状态装进整值对象（`workspaceRecord.sessionIds` 数组、
   `workspaceDomainState.workspaceIds` / `archivedSessionIds` 数组、待恢复的
   `pendingMutation`），文件介质只能整文档重写。接管后全部拆成行/列：
   - 会话归属 → `t_workspace_sessions`（一个归属一行 + `f_position`，可按
     session 反查 workspace）；
   - 显示顺序 → `t_workspaces.f_position`（不在顺序中的记录为 -1）；
   - **归档状态 → `t_sessions.f_archived_at`（非空即已归档）**，与会话行
     同表，对齐上游"归档叠加在归属之上、保留归属槽位"的语义；
   - 两写标记 → `t_workspace_state.f_pending_operation` /
     `f_pending_workspace_id`；
   - 投影 checkpoint → 每个投影 key 一行（`t_session_projcache_row`），
     identity 复用会话行（1:1 不拆表）；
   - **会话标题 → `t_sessions.f_title` / `f_title_seq`**：写路径遇到
     `session/title` 事件即刷新、rewind 截断后重算，列表消费在 checkpoint 行
     缺 title 时直接取该列。
     workspace 的每次写入（记录 + 归属、顺序 + 归档）在介质事务内整体替换，
     不留部分应用的中间态。
4. **禁用官方文件介质**：`packages/better-session/cordis.patch.yml` 禁用
   `storage-json` 与 `session-projection-cache`，并把 `storage-domain` 的 config
   覆盖为 `{ backend: rdb }`（patch 按 id 替换整段 config）。
5. **旧数据显式导入**：`just import-storages`（`src/import-storages.ts` +
   `tool/import-storages.ts`）把旧 JSON 写进同一批表；旧文件保留不删。
   projcache 可以不导入（派生缓存会重建），导入只为保住首屏冷读性能。

## 后果

- `$DSH_HOME/storages` 不再产生或更新文件；PostgreSQL 场景下 workspace 与
  投影 checkpoint 随库共享，多实例不再各写各的。
- workspace 的写入从"整文档重写"变成行级 upsert；归档、归属、顺序都能直接
  SQL 查询（归档即 `t_sessions.f_archived_at IS NOT NULL`，归属在
  `t_workspace_sessions`）。
- 表结构与上游域 spec 版本绑定（projcache v7、workspace v2）：上游升级域版本
  时需要同步适配（迁移 + 记录映射），当前由
  `t_storage_units` 的版本戳 fail loud 暴露不匹配。
- 存储层类型直接复用上游契约（`WorkspaceRecord` / `WorkspaceDomainState` /
  `CheckpointIdentity` / `ProjectionCheckpoint`，全部 `import type`，运行时零
  依赖）：上游 spec 变化在编译期暴露，本包不复制一份结构定义（`types.ts` 只
  声明 `StorageRepository` 接口与"上游类型 + 会话键"的组合）。
- `rdb` KV 后端只服务 `workspace` 域：未知 unit 名直接报错，表结构显式维护，
  不做通用 KV 兜底。
- 归档标记落在会话行上，因此要求会话已物化（`t_sessions` 有行）：live 但从未
  落库的会话归档时没有可标记的行（后续 workspace 写入会重试该标记）。
- 读路径直读介质（SQLite）：`cachedSnapshot` 系列同步查表，进程里不再有
  第二份 checkpoint 表；PostgreSQL 因驱动异步保留写穿镜像，重启或他实例
  写入读作 cache miss（与官方 json 介质的行为等价）。
