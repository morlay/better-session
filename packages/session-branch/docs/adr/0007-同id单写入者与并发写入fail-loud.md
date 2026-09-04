# 0007-同 id 单写入者与并发写入 fail loud

rdb 后端按稠密 seq 重编号（瞬时过滤后），而每个 `PersistenceCoordinator`
实例只在内存维护自己的上游 seq 游标——两个后端实例共享同一数据库时，
**同一个 session id 只能有一个写入者**：后端记录每个 session「本实例最后
确认的稠密 head」，`appendBatch` 在事务内校验磁盘 head 与该记录一致；
不一致（另一写入者提交过、或本实例从未读过该 session 却遇到已有行）时
**fail loud 拒绝**，而不是把本批次静默重编号到对方尾部。

## 考虑过的选项

- **静默重编号续接**：把两组独立 turn 拼接成同一个 log，事件内容与 seq
  语义全部错位——log 级损坏，`UNIQUE(f_session_id, f_sequence)` 无法拦截
  （稠密重编号天然无冲突）。
- **跨实例协调器**：超出本后端职责，需要分布式锁 / 租约基础设施。

## 后果

- 不同 session id 的并发写不受影响（各自独立 head）——多进程部署时各实例
  各写各的 session 是受支持场景。
- 一个实例 load（或 HMR adopt）过某 session 后可以继续 append——那是一次
  明确授权、基于最新磁盘状态的续接。
