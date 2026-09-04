# rdb 替换官方 JSONL 持久化

官方 `@deepseek-ai/dsh-session-persistence-jsonl` 是 append-only 顺序介质
后端（每会话一个文件，zstd 帧 + packChunks 压缩行），只有
`loadStored` / `appendBatch` / `commitRepair`，没有显式回退原语。装配时
禁用官方 jsonl（`session-persistence-jsonl: disabled: true`），用
`@morlay/session-rdb`（SQLite / PostgreSQL）替换——因为就地编辑的核心
rewind 需要**原子截断**（截断尾部 + 重写，失败整体回滚），而 JSONL 的
截断（truncate + 重写）无原子性（官方 `commitRepair` 注释明说崩溃修复
"不需要原子"）；RDB 事务提供原子截断，并顺带获得并发写入者检测、fork
事件行复用与 SQL 查询（timeline / 审计）。

## 考虑过的选项

- **保留官方 JSONL 并扩展回退原语**：违反「上游不可修改」红线；且 JSONL
  顺序介质上截断重写无原子性，多实例共享同一存储时无并发写检测。
- **rdb 与 jsonl 并存**：装配只允许一个 `ctx.sessionPersistence`；jsonl
  保留为导出/导入格式（`session.jsonl` artifact 复用，`readRaw` /
  `parseJsonlArtifact`），用户可随时切回（disabled 而非删除）。

## 后果

- 官方 jsonl 的 zstd 压缩、packChunks、torn tail 修复不复用——rdb 自建
  崩溃修复（torn tail 物理删除 + 合成 closers）与稠密 seq 重编号（瞬时
  事件与 ignorable 事件不入库）。
- 需要维护 `SCHEMA_VERSION` 门禁与一次性迁移脚本。
- 多实例共享数据库成为受支持场景（不同 session 各写各的，同 id 并发写
  fail loud）。
