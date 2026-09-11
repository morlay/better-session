# 0001-rdb 替换官方 JSONL 持久化

官方 `@deepseek-ai/dsh-session-persistence-jsonl` 是 append-only 顺序介质
后端（每会话一个文件，zstd 帧压缩行），走 `SessionHandle` 面（`read` /
`append` / `flush` / `close`），没有显式回退原语。装配时
禁用官方 jsonl（`session-persistence-jsonl: disabled: true`），用
`@morlay/session-rdb`（SQLite / PostgreSQL）替换——因为就地编辑的核心
rewind 需要**原子截断**（截断尾部 + 重写，失败整体回滚），而 JSONL 的
截断（truncate + 重写）无原子性（官方 `truncateTornTail` 明说崩溃修复
"不需要原子"）；RDB 事务提供原子截断，并顺带获得并发写入者检测、fork
事件行复用与 SQL 查询（timeline / 审计）。

## 考虑过的选项

- **保留官方 JSONL 并扩展回退原语**：违反「上游不可修改」红线；且 JSONL
  顺序介质上截断重写无原子性（写租约只保证单写者，不提供回退原语）。
- **rdb 与 jsonl 并存**：装配只允许一个 `ctx.sessionPersistence`；jsonl
  保留为导出/导入格式（`session.jsonl` artifact 复用，`readRaw` /
  `parseJsonlArtifact`），用户可随时切回（disabled 而非删除）。

## 后果

- 官方 jsonl 的 zstd 压缩、torn tail 修复不复用——rdb 自建崩溃修复
  （torn tail 在下一次写 append 时截断）与原样存储（事件原样落库，无过滤
  无重编号）。
- 需要维护 `SCHEMA_VERSION` 门禁与 drizzle-kit 生成的迁移（`drizzle/`
  目录，运行时 drizzle `migrate()` 执行）。
- 多实例共享数据库成为受支持场景（不同 session 各写各的，同 id 并发写
  fail loud）。
