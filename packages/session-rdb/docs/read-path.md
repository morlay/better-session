# 读路径流程（load / readFrom）

```
t_session_events JOIN t_events（按 f_sequence 排序）
  │
  ├─ rowToEvent：f_data 解析（完整事件，含 ignorable 信封；兼容旧 v2 库的
  │   纯 data 形状——判别完整事件四键）
  │
  ├─ scanRows：崩溃尾部语义（last turn/end 切割、torn tail 截断）
  │
  └─ 读取时修复（repairReadView，视图只读，不落库）：
      ├─ repairAssistantSettlement：assistant/message|attempt 缺 `stream` 补
      │   `[]`——旧写入器不落库流式记录，上游 seed 校验要求 turn/step/stream
      │   齐备
      ├─ repairSurfaceOps：非法 replace 降级 append；end 落在旧坐标空间的
      │   replace 按紧邻 metering 的 shadowedSeqs 数量夹取到当前 surface 的
      │   同长区间（保住压缩语义，否则降级会让被压缩历史全部回到派生历史）；
      │   缺 surfaceOp 补标记；非 surface-eligible 清掉
      ├─ syncMeteringRanges：紧邻 replace 的 metering 事件 `shadowedRange` /
      │   `shadowedSeqs` 与该 replace 的稠密 range 不一致时重写——旧写入器
      │   重编号后二者一起落在旧坐标空间；上游 token-meter 契约要求紧邻的
      │   metering range 与 replace range 完全一致
      ├─ recomputeReplaceProvenance：replace 事件 sourceEventSeqs 优先取紧邻
      │   metering 事件（compaction/summary|prune）的 shadowedSeqs（权威
      │   列表）；无 metering 事件时回退为 surfaceOp range 内的全部 surface
      │   节点 seq 集合——满足上游 assertProvenance 的 shadowed 覆盖硬校验
      └─ repairOrphanInboxSplices：孤儿 inbox splice 改写为 no-op
```

## 规则

- **原样存储、原样读取**：事件 seq 即稠密 seq，无坐标映射；`f_data` 存完整
  事件（含 ignorable 信封），读回时整体解析。
- **suffix 读取（`readFrom`）不补 provenance**：消费者 timeline 只找版本
  事件，不重放 surface。
- **replace 的 provenance 采用权威 shadowedSeqs**：`shadowedRange` 是
  surface 位置跨度（首尾节点 seq），不是数值区间——压缩竞态下并发落地的
  节点可能落在 range 数值区间之外，range 扫描会漏掉它们（上游
  `assertProvenance` 报 missing）。紧邻 metering 事件的 `shadowedSeqs`
  显式列出全部被遮蔽节点，是权威来源；无 metering 事件时（历史数据 /
  非压缩 replace）回退 range 扫描。`syncMeteringRanges` 只在 metering 与
  replace 的 range 已经不一致时改写（旧坐标残留），当前写入器的权威
  `shadowedSeqs` 因此原样保留。
- 读取结果 seq 稠密连续 → `ctx.sessions.create(id, { seed })` 直接通过上游
  contiguous-from-0 校验，后续 append 从稠密 cursor 继续。
- 崩溃尾部语义：last `turn/end` 之前的缺陷（unparsable / seq gap）拒绝；
  之后的缺陷容忍为 torn tail（`tornFrom` 标记，load 时物理删除）。
- 未闭合轮次（无 turn/end）**原样保留**：持久化层不补合成 closers，补
  closers 由消费方（Session 恢复 / agent-loop resume）负责。
- **混合世代 log 回退**：`f_version < 2` 的会话先走上游迁移链；迁移链拒绝
  （旧写入器跨上游版本追加、log 不是任何单一已发布格式）时回退为当前格式
  视图（header 版本归一 + 上述修复），旧类型（`assistant/chunk` 等）仍由
  `validateStoredEvents` fail-loud 拒绝（见 [legacy-clean.md](legacy-clean.md)）。
