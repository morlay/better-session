# 写路径流程（appendBatch）

```
live log（上游 seq）
  │
  ├─ 当前格式校验：validateStoredEvents（未知类型非 ignorable / 非法消息形状拒绝）
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

- **写路径零转换**：事件内容、surfaceOp 全部原样落库；无过滤无重编号
  （不变量与坐标模型见 [design.md](design.md)）。
- **写路径当前格式校验（fail-closed）**：`appendBatch` 落库前经
  `validateStoredEvents` 校验——未知类型（非 ignorable）与非法消息形状拒绝
  入库，新入库数据只能是当前格式形状。非当前格式（v0/v1/v2）数据只在读取时
  经 legacy 转换链动态转换；写打开时若迁移视图与存储桥接行数不一致（迁移链
  会生成/合并事件），先整体落库一次，使读写同坐标（见
  [legacy-clean.md](legacy-clean.md)）。
- 事件行**已存在则复用**（fork 派生会话引用父会话事件行，经 seq→eventId
  复用映射命中则跳过插入），否则新建。
- 事务是原子性 + 持久性边界：mid-batch 失败（UNIQUE 冲突）整体回滚。
- 写锁：SQLite `BEGIN IMMEDIATE`（busy_timeout 排队）；PG 依赖事务行锁 +
  `UNIQUE(f_session_id, f_sequence)` 拒绝冲突批次。
- 并发写入者校验（`assertNoConcurrentWriter`）在落库**之前**执行——磁盘
  head 必须等于本实例最后确认的 head，否则 fail loud（见
  [concurrency.md](concurrency.md)）。

## 上游 seq 与稠密 seq 的关系

原样存储下事件 seq 即稠密 seq（`f_sequence`），写读天然对齐——无需坐标
映射（见 [read-path.md](read-path.md)）。非当前格式会话经迁移链读取时事件数
可能与存储行数不同（生成 end-seed / 合并 chunk），写打开会把迁移视图整体
落库（`rewriteMigratedLog`，事务内删桥接行 + 按视图重建 + head/revision
更新），此后该会话即普通当前格式会话。
