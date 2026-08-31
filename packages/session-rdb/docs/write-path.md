# 写路径流程（appendBatch）

```
live log（上游 seq，含瞬时事件）
  │
  ├─ 过滤：assistant/chunk 与 ignorable 事件 → 丢弃（不入库）
  │
  ├─ 稠密重编号：幸存事件 f_sequence = head+1 .. head+n（连续递增）
  │
  ├─ 桥接行记录上游 seq：f_original_seq = 事件原始 seq（重映射查阅）
  │
  ├─ surfaceOp：原样序列化到桥接行 f_surface_op（原始坐标——replace 的
  │   range 是上游 seq，读取时重映射）
  │
  ├─ f_data：完整原始 data 原样落库（含 turn/step、shadowedRange 原始坐标）
  │
  └─ 落库：t_events 行（完整原始 data）+ t_session_events 桥接行（f_sequence /
      f_original_seq / f_surface_op），单事务
```

## 规则

- **写路径零转换**：事件内容、surfaceOp、shadowedRange 全部原样落库；坐标
  转换集中在读取路径（有 `f_original_seq` 可查，无启发式）。
- 只含瞬时事件的批次是 no-op：不建行、不 bump revision。
- 事件行**已存在则复用**（fork 派生会话引用父会话事件行），否则新建
  （`INSERT OR IGNORE` 语义 + 桥接行引用已存在 id）。
- 事务是原子性 + 持久性边界：mid-batch 失败（UNIQUE 冲突）整体回滚。
- 写锁：SQLite `BEGIN IMMEDIATE`（busy_timeout 排队）；PG 依赖事务行锁 +
  `UNIQUE(f_session_id, f_sequence)` 拒绝冲突批次。
- 并发写入者校验（`assertNoConcurrentWriter`）在重编号**之前**执行——磁盘
  head 必须等于本实例最后确认的 head，否则 fail loud（见
  [concurrency.md](concurrency.md)）。

## 上游 cursor 与稠密 head 的关系

- **首次 append（无 seed）**：上游 seq 与稠密 seq 同起点（0），`f_original_seq`
  含瞬时空洞（chunk 不入库）。
- **load / adopt 重建 seed 后**：coordinator 的 cursor 从稠密 seed 尾部续接，
  **此后上游 seq 与稠密 seq 恒等**（新 append 部分）——写读对齐的关键
  不变量（见 [read-path.md](read-path.md)）。
