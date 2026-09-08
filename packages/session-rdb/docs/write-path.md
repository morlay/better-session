# 写路径流程（appendBatch）

```
live log（上游 seq）
  │
  ├─ v2 校验：validateStoredEvents（未知类型非 ignorable / 非法消息形状拒绝）
  │
  ├─ f_data：完整事件原样落库（type/seq/time/data/ignorable 信封，与 JSONL
  │   每行同构）
  │
  ├─ surfaceOp：原样序列化到桥接行 f_surface_op（append / replace 原样）
  │
  └─ 落库：t_events 行（完整事件）+ t_session_events 桥接行（f_sequence /
      f_surface_op），单事务
```

## 规则

- **写路径零转换**：事件内容、surfaceOp 全部原样落库；无过滤无重编号——
  事件 seq 即稠密 seq（上游 seq 与稠密 seq 恒等）。
- **写路径 v2 校验（fail-closed）**：`appendBatch` 落库前经
  `validateStoredEvents` 校验——未知类型（非 ignorable）与非法消息形状拒绝
  入库，新入库数据只能是 v2 形状。旧格式（v0/v1）数据只在读取时经 legacy
  转换链动态转换，不落新库。
- 事件行**已存在则复用**（fork 派生会话引用父会话事件行），否则新建
  （`INSERT OR IGNORE` 语义 + 桥接行引用已存在 id）。
- 事务是原子性 + 持久性边界：mid-batch 失败（UNIQUE 冲突）整体回滚。
- 写锁：SQLite `BEGIN IMMEDIATE`（busy_timeout 排队）；PG 依赖事务行锁 +
  `UNIQUE(f_session_id, f_sequence)` 拒绝冲突批次。
- 并发写入者校验（`assertNoConcurrentWriter`）在落库**之前**执行——磁盘
  head 必须等于本实例最后确认的 head，否则 fail loud（见
  [concurrency.md](concurrency.md)）。

## 上游 seq 与稠密 seq 的关系

原样存储下事件 seq 即稠密 seq（`f_sequence`），写读天然对齐——无需坐标
映射（见 [read-path.md](read-path.md)）。
