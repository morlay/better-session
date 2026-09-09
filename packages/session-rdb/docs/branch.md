# 分支能力（forkFrom / rewind / timeline）

本包在 `SessionPersistenceRdb`（handle 模型，append-only 面）之上实现
`@morlay/session-branch` 的 `SessionBranchProvider`（分支面：rewind / forkFrom /
readBranchPrefix），并在插件构造时自动注册 `ctx.sessionBranch`
（`SessionBranchRdb`）——同一数据库连接、同一写路径，形成 rewind / retry /
fork 的持久化闭环。

## forkFrom：纯 append + 事件行复用

- 读源会话（`readLog`）→ `locateTurnEnd` 定位闭合边界（`after` 包含目标轮 /
  `before` 排除目标轮）→ 取前缀；
- 前缀按**新会话 log 保序重编号**（`map((e, i) => ({ ...e, seq: i }))`）；
- **坐标无需重映射（关键论证）**：原样存储下事件 seq 即稠密 seq，前缀
  `slice(0, boundary + 1)` 从父稠密 seq 0 开始（稠密连续），重编号后子会话
  seq 与父稠密 seq **数值相同**（0..boundary）——replace range 数值不变，
  `Session.create` 的 seed 校验（range 存在于 surface、assertProvenance 的
  「引用更早事件」）天然成立。`seedSuffix` 的 manualTurn 事件 surfaceOp 是
  `append`（无 range），版本效果 ignorable 事件原样落库——无坐标问题。
- `create(childMeta)` + `append(childId, seed)` 走上游 handle——派生是纯
  append（新 id / `parentSession` / `seedLength`），不触碰源会话；
- **事件行复用**：`t_events` 是全局实体，派生会话的桥接行直接引用源会话
  已存在的事件行（`f_event_id` 复用），**不复制事件行**——只插入
  `t_session_events` 桥接行（新 `f_sequence` + `f_surface_op`）。轮次编号
  **延续**（f_data 完整保留 turn/step，复用事件行即延续），子会话后续 append
  从边界处继续编号。写路径按「事件行已存在则复用、否则新建」处理
  （`INSERT OR IGNORE` 语义 + 桥接行引用已存在 id）；
- `seedSuffix`（版本效果事件等）按调用方构造追加；携带 `ignorable: true` 的
  版本效果事件**原样落库**（与 JSONL 一致），live 会话的内存 log 与 canonical
  log 一致。

### fork 子会话的 f_sequence 语义

子会话桥接行的 `f_sequence` 是**子会话自己的上游空间**（重编号后的 0..n-1
及后续 append 的 n..），与父会话无关——`f_data` 里的坐标在 fork 时已重编号
到子空间，读取时 per-session 恒等自洽。**不复制父会话的 f_sequence**（复制
会导致两段空间重叠、映射歧义）。

## rewind：绕过 handle 模型的直接截断 + 状态同步

上游 `SessionHandle` 模型只有 append-only，没有显式回退原语。rewind 直接
操作后端事务：

1. **边界校验**：`toBoundary` 是已存在事件且为闭合 `turn/end`（或 `-1`
   空前缀）；live 会话先落盘 write-behind 缓冲，保证后续读取与后端事务
   同视图；
2. **事务内截断**：`deleteBridgeTail(toBoundary + 1)` + head 游标回退（
   `getPrevBridge` 或初始 `-1`）+ `bumpRevision`——Abort 整体回滚。**只删
   桥接行**，事件行保留（全局实体，可能被其他会话引用）；截断进入继承前缀
   （或清空）时把 `f_seed_length` **收缩**到保留事件数（只收缩、不扩张）——
   否则存储出现「继承前缀超过存储事件数」的矛盾，上游 load 拒绝（见
   [legacy-clean.md](legacy-clean.md)）；
3. **更新 `WriteGuard` 确认 head**：下一次 append 的并发写入者校验以截断后
   head 为基准；
4. **live 会话同步**：截断内存 log 并重置派生缓存（`truncateLiveSession`）、
   失效 `ctx.sessionProjections` 的单元缓存（投影按 `observedSeq` 增量驱动，
   水位不回退会让截断后的重放事件被 `drive()` 跳过）、重置 agent 轮次游标、
   `resetAfterRewind()` 对齐 write handle 的 cursor 与继承前缀，最后强制
   durable 取消 agent 的排队输入（`inbox.clear()`；落在保留区的 pending 同样
   取消——否则 agent 会继续处理 rewind 已放弃的输入）。

**保留区 replace range 完整性（不变量）**：replace 的 range 引用**更早事件**
（上游契约：range `startSeq`/`endSeq` 必须存在于当前 surface，即已提交节点），
故 `range.endSeq < replace.seq`。rewind 只删尾部（`toBoundary + 1` 起），保留区
replace（`seq ≤ toBoundary`）的 range 内节点全部 `< replace.seq ≤ toBoundary`，
**全部保留**——映射完整、`startSeq`/`endSeq` 存在、重计算 provenance 覆盖成立。
「保留区 replace 的 range 引用被删事件」在数学上不可能发生。torn tail 截断
同理安全。

已知限制：rewind 是 rdb 特有的直接截断，未与 handle 模型的 per-id 串行链
互斥（无法从外部访问）；文档要求对 cold 会话调用（无 live owner、无
in-flight append）。多实例共享数据库时 rewind 与并发 append 的交错由事务 +
head 校验兜底。

## timeline：版本树投影

`parentSession` + `seedLength` 构成 lineage 骨架（header 字段，现有表无需
改动）；live 会话从内存 log 读自有后缀（含 `session-branch/version` 效果
事件），cold 会话走 `readFrom`（版本效果原样落库 → 效果详情可恢复）。
