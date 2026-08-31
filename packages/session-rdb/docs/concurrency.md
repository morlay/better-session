# 并发写入者检测（多个实例/进程共享同一数据库）

本后端的事件按**稠密 seq** 重编号（瞬时过滤后），而每个
`PersistenceCoordinator` 实例只在内存里维护自己的**上游 seq** 游标。因此两个
后端实例（另一个 `dsh` 进程、或同一进程内重复加载的持久化插件）共享同一
`sessions.sqlite` 时，**同一个 session id 只能有一个写入者**：

- 后端记录每个 session「本实例最后确认的稠密 head」（来自本实例的写入或
  `loadStored` 观察）；`appendBatch` 在事务内校验磁盘 head 与该记录一致。
- 磁盘 head 已被其他实例推进（另一写入者提交过）、或本实例从未读过该 session
  却遇到已有行时，append **fail loud 拒绝**（`modified by another writer` /
  `has a persisted log this instance has not read`），而不是把本批次静默重编号到
  对方尾部——后者会把两组独立 turn 拼接成同一个 log，**事件内容与 seq 语义
  全部错位**（log 级损坏，`UNIQUE(f_session_id, f_sequence)` 无法拦截，因为
  稠密重编号天然无冲突）。
- 不同 session id 的并发写不受影响（各自独立 head），两个实例各写各的 session
  是受支持的多进程部署（`busy_timeout` 只负责让写锁竞争排队）。
- 一个实例 `load`（或 HMR adopt）过某 session 后可以继续 append——那是一次
  明确授权、基于最新磁盘状态的续接；同 id 双实例「都 load 过再各自写」仍不
  支持（需要跨实例协调器，超出本后端职责）。
