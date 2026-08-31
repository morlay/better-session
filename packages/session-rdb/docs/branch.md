# 分支能力（forkFrom / rewind / timeline）

本包在既有 `PersistenceBackend`（append-only 面）之上实现
`@morlay/session-branch` 的 `SessionBranchProvider`（分支面：rewind / forkFrom /
readBranchPrefix），并在插件构造时自动注册 `ctx.sessionBranch`
（`SessionBranchRdb`）——同一数据库连接、同一 coordinator 写路径，形成
rewind / retry / fork 的持久化闭环。

## forkFrom：纯 append + 事件行复用

- 读源会话（`inspect`）→ `locateTurnEnd` 定位闭合边界（`after` 包含目标轮 /
  `before` 排除目标轮）→ 取前缀；
- 前缀按**新会话 log 保序重编号**（`map((e, i) => ({ ...e, seq: i }))`）；
- **坐标无需重映射（关键论证）**：`inspect` 返回的是**读取视图**——`surfaceOp`
  的 replace range 已经过 `f_original_seq` 映射重映射到**父会话稠密坐标**。
  前缀 `slice(0, boundary + 1)` 从父稠密 seq 0 开始（稠密连续），重编号后
  子会话 seq 与父稠密 seq **数值相同**（0..boundary）——replace range 数值
  不变，`Session.create` 的 seed 校验（range 存在于 surface、assertProvenance
  的「引用更早事件」）天然成立。`seedSuffix` 的 manualTurn 事件 surfaceOp 是
  `append`（无 range），版本效果 ignorable 不入库——无坐标问题。
- `create(childMeta)` + `append(childId, seed)` 走上游 coordinator——派生是
  纯 append（新 id / `parentSession` / `seedLength`），不触碰源会话；
- **事件行复用**：`t_events` 是全局实体，派生会话的桥接行直接引用源会话
  已存在的事件行（`f_event_id` 复用），**不复制事件行**——只插入
  `t_session_events` 桥接行（新 `f_sequence` + `f_original_seq` +
  `f_surface_op`）。轮次编号**延续**（f_data 完整保留 turn/step，复用事件行
  即延续），子会话后续 append 从边界处继续编号。写路径按「事件行已存在则
  复用、否则新建」处理（`INSERT OR IGNORE` 语义 + 桥接行引用已存在 id）；
- `seedSuffix`（版本效果事件等）按调用方构造追加；携带 `ignorable: true` 的
  版本效果事件按语义**不进 canonical log**（rdb `isPersistedEvent` 丢弃），
  live 会话的内存 log 保留、cold timeline 只有 lineage 骨架。

### fork 子会话的 f_original_seq 语义

子会话桥接行的 `f_original_seq` 是**子会话自己的上游空间**（重编号后的
0..n-1 及后续 append 的 n..），与父会话无关——`f_data` 里的原始坐标（父
空间）在 fork 时已重映射到子空间，读取时 per-session 映射（子空间 →
子稠密）恒等自洽。**不复制父会话的 f_original_seq**（复制会导致两段空间
重叠、映射歧义）。

## rewind：绕过 coordinator 的直接截断 + 状态同步

上游 `PersistenceCoordinator` 只有 append-only + torn-tail 修复（`commitRepair`），
没有显式回退原语。rewind 直接操作后端事务：

1. **独占校验**：无 live owner（`ctx.sessions.get(id) === undefined`），否则
   `REWIND_CONFLICT`；prepared reservation 无法公开查询，靠 revision 变化
   自然失效；
2. **边界校验**：`toBoundary` 是已存在事件且为闭合 `turn/end`（或 `-1` 空前缀）；
3. **事务内截断**：`deleteBridgeTail(toBoundary + 1)` + head 游标回退（
   `getPrevBridge` 或初始 `-1`）+ `bumpRevision`——与 `commitRepair` 的事务
   模式同构，Abort 整体回滚。**只删桥接行**，事件行保留（全局实体，可能被
   其他会话引用）；
4. **同步 coordinator 状态**：rewind 后 `load(id)`——revision 变化使
   `isPreparedSourceCurrent` 失效 → 重新 adopt → `state.cursor` 与新尾部一致；
   截断到闭合 turn/end 后 log 平衡，load 的 repair 为 no-op；
5. **更新 `WriteGuard` 确认 head**：下一次 append 的并发写入者校验以截断后
   head 为基准。

**保留区 replace range 完整性（不变量）**：replace 的 range 引用**更早事件**
（上游契约：range start/end 必须存在于当前 surface，即已提交节点），故
`range.end < replace.seq`。rewind 只删尾部（`toBoundary + 1` 起），保留区
replace（`seq ≤ toBoundary`）的 range 内节点全部 `< replace.seq ≤ toBoundary`，
**全部保留**——映射完整、start/end 存在、重计算 provenance 覆盖成立。
「保留区 replace 的 range 引用被删事件」在数学上不可能发生。torn tail 截断
同理安全。

已知限制：rewind 是 rdb 特有的直接截断，未与 coordinator 的 per-id 串行链互斥
（无法从外部访问）；文档要求对 cold 会话调用（无 live owner、无 in-flight
append）。多实例共享数据库时 rewind 与并发 append 的交错由事务 + head 校验兜底。

## timeline：版本树投影

`parentSession` + `seedLength` 构成 lineage 骨架（header 字段，现有表无需改动）；
live 会话从内存 log 读自有后缀（含 `session-branch/version` 效果事件），cold
会话走 `readFrom`（效果不落 canonical log → 无效果详情，仅骨架）。
