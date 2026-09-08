# 旧数据修复（导出即修复）

旧数据（本设计之前的代码写入）的特征：

- `t_events` 带 `f_source_event_seqs` / `f_surface_op` 列（上游坐标 provenance
  落库）；
- `f_original_seq` 在 `t_events`（事件行）而非桥接行；
- `f_kind` 语义为「= 上游 type」（旧）而非「事件种类」（新）。

新格式读取对旧数据**不兼容**（可能 surface 校验失败）。修复分两层：

## 表结构级迁移（drizzle-kit）

v1 → v2 表结构迁移由**上个版本**完成（本版本不做跨版本迁移）；v2 → v3 由
drizzle-kit 生成迁移（`drizzle/` 目录，删 `t_session_events.f_original_seq`、
建 `t_schema_meta`），运行时 drizzle `migrate()` 执行——旧版本库首次打开时
把 v2 baseline 标记为已应用，只执行 v3 diff。

## 数据格式级修复（导出即修复）

表结构已 v2、但数据仍是旧格式（`f_data` 纯 data 形状、`f_surface_op` 上游
坐标）或 surface **语义**损坏（非法 replace 导致 seed 校验失败）时，
**不再需要单独的修复逻辑**——修复并入导出路径（`readRaw`），导出即修复：

1. 读取会话全部事件行，按旧格式解析（`rowToEvent` 兼容纯 data 形状）；
2. 序列化前对内存事件列表应用容错修复（`repairSurfaceOps`，不落库）：
   - 非法 replace（range 不在当前 surface / tool/result 重写约束失败 /
     surfaceOp 畸形）→ 降级为 `append`；
   - surface-eligible 事件缺 `surfaceOp` → 补 `append` 标记；
   - 非 surface-eligible 事件携带 `surfaceOp` → 清掉；
3. 重算 replace 的 `sourceEventSeqs`（`recomputeReplaceProvenance`，不落库）；
4. **收缩继承前缀长度**：存储的 `f_seed_length` 超过实际事件数（历史
   rewind 未收缩的损坏样式）时收缩到事件数，使 artifact 自洽（上游 load
   把「继承前缀超过存储事件数」当损坏拒绝）；
5. 序列化为 JSONL artifact（`toJsonlArtifact`）——产出的 artifact **完备
   可用**：导入（`parseJsonlArtifact`，同样防御性收缩）后无需任何修复即可
   加载。

修复只作用于导出视图，**不落库**（写路径零转换不变量不变：存储行与
revision 在导出前后完全一致）。历史加载失败的会话仍可正常导出，导出的
zip 导入后即为可用的新会话。

## 根因修复（rewind 收缩 seedLength）

「继承前缀超过存储事件数」的根因是 rewind 截断**没有收缩 `f_seed_length`**：
截断进入继承前缀（或清空整个 log）后，`f_seed_length` 残留旧值，下一次
append 的 upsert 又把它原样写回 → 矛盾固化。`rewind` 现在在事务内把
`f_seed_length` 收缩到保留事件数（只收缩、不扩张），并同步 live write
handle 的继承前缀（否则下一次 append 会把旧值覆盖回去）。
