# 旧数据修复（导出即修复）

旧数据（本设计之前的代码写入）的特征：

- `t_events` 带 `f_source_event_seqs` / `f_surface_op` 列（上游坐标 provenance
  落库）；
- `f_original_seq` 在 `t_events`（事件行）而非桥接行；
- `f_kind` 语义为「= 上游 type」（旧）而非「事件种类」（新）；
- `f_data` 是纯 data 形状（旧写入器只落 `event.data`），且可能缺新版本
  引入的字段（如 `assistant/message.stream`）。

修复分两层：表结构级迁移（drizzle-kit）+ 读取/导出视图修复（不落库）。

## 表结构级迁移（drizzle-kit）

表结构版本策略、迁移执行方式与 v3 diff 内容见 [schema.md](schema.md)；
本节只讲数据格式级修复。

## 混合世代 log 的回退读取

旧写入器只在建会话时落一次 `f_version`，之后跟随上游演进继续追加事件：同一个
log 可能是**混合世代**（v0 时代的行 + 新版本字段，如 `permission/preset.origin`、
`subagent/descriptor` version 2），不是任何单一已发布格式。严格的上游迁移链
（v0 → v1 → v2 → v3）对这种 log 必然拒绝。

`readLog` 因此先尝试迁移链（真旧格式数据，含 `assistant/chunk`、旧消息形状），
拒绝后回退 `adoptLegacyRows`：

1. header 版本归一到 `SESSION_FORMAT_VERSION`（其余 header 字段来自存储行）；
2. 按稠密 seq 采用行数据（`rowToEvent` 兼容纯 data 形状、归一面字段名）；
3. 继承前缀收缩到实际事件数；
4. `repairRequestHeaders` 把旧格式 `request/header` 归一为当前格式（v3 起
   system prompt 由 surface 上的 `system/message` 承载，header 必须省略
   `system` / 空 `tools` / 空 `adapterDefaults`）——必须发生在调用方
   `validateStoredEvents` 之前，否则会话加载失败；
5. 交给读取视图修复（`repairReadView`）：补 `assistant/message.stream`、越界
   replace 按 metering 数量夹取或降级、metering range 对齐、provenance 重算、
   孤儿 inbox splice 改写（见 [read-path.md](read-path.md)）。

回退不放松 fail-loud：旧事件类型（`assistant/chunk`、`compact/*` 等）仍由
`validateStoredEvents` 拒绝；已提交区的 seq gap / 不可解析行仍由 `scanRows`
拒绝。

## 写打开时落库迁移（坐标对齐）

迁移链会**生成/合并事件**（继承切点的 `session/end-seed`、无 message 的
`assistant/attempt`、chunk 合并），迁移视图的事件数因此可能与存储桥接行数
不同。读坐标与写坐标（存储 head）不一致时，`append` 按 head 重编号会撞上
已有行或写坏 log。

因此 `open(id, "write")` 检测到「迁移视图事件数 ≠ 存储行数」时，在同一事务
内执行 `rewriteMigratedLog`：删光本会话桥接行 → 按迁移视图重建（新事件行，
完整信封 + 桥接行）→ 更新 head 与 revision。此后该会话是普通当前格式会话，
读写同坐标；旧事件行保留（可能被 fork 子会话引用，孤儿由惰性 GC 处理）。
混合世代回退视图（`adoptLegacyRows`）与存储行同坐标，不触发落库迁移。

## 数据格式级修复（导出即修复）

表结构已是当前版本、但数据仍是旧格式（`f_data` 纯 data 形状、`f_surface_op`
上游坐标）或 surface **语义**损坏（非法 replace 导致 seed 校验失败）时，
**不再需要单独的修复逻辑**——修复并入读取/导出路径（`readRaw`），导出即修复：
读取会话全部事件行（`rowToEvent` 兼容纯 data 形状）→ 应用 `repairReadView`
容错修复（明细见 [read-path.md](read-path.md)，含继承前缀收缩）→ 重算 replace
provenance → 序列化为 JSONL artifact（`toJsonlArtifact`）。产出的 artifact
**完备可用**：导入（`parseJsonlArtifact`，同样防御性收缩）后无需任何修复即可
加载。

修复只作用于读取/导出视图，**不落库**（写路径零转换不变量不变：存储行与
revision 在读取/导出前后完全一致）。

## 根因修复（rewind 收缩 seedLength）

根因与修复见 [branch.md](branch.md)：rewind 截断后在事务内把 `f_seed_length`
收缩到保留事件数（只收缩、不扩张），并同步 live write handle 的继承前缀
（否则下一次 append 会把旧值覆盖回去）。
