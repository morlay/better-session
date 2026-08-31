# 读路径流程（load / readFrom）

```
t_session_events JOIN t_events（按 f_sequence 排序）
  │
  ├─ 构建上游→稠密映射：f_original_seq → f_sequence（每会话一次）
  │
  ├─ rowToEvent：f_data 解析（完整原始 data）+ 坐标转换：
  │   ├─ turn/step：保留（f_data 已含，无需注入）
  │   ├─ surfaceOp：replace 的 start/end range 经映射重映射到稠密坐标
  │   │   （append 无坐标，原样）
  │   └─ shadowedRange（compaction/summary|prune）：经映射重映射到稠密坐标
  │
  ├─ scanRows：崩溃尾部语义（last turn/end 切割、torn tail 截断）
  │
  └─ recomputeReplaceProvenance（仅完整 log 读取）：
      replace 事件 sourceEventSeqs = surfaceOp range 内（稠密坐标）的全部
      surface 节点（user/message / assistant/message / tool/result）seq 集合
      ——满足上游 assertProvenance 的 shadowed 覆盖硬校验
```

## 规则

- **坐标转换集中在读取路径**：`f_original_seq` 提供上游→稠密映射（无启发
  式——映射是存储事实，不是猜测）。
- **suffix 读取（`readFrom`）不补 provenance**：消费者 timeline 只找版本
  事件，不重放 surface。
- 读取结果 seq 稠密连续 → `ctx.sessions.create(id, { seed })` 直接通过上游
  contiguous-from-0 校验，后续 append 从稠密 cursor 继续。
- 崩溃尾部语义：last `turn/end` 之前的缺陷（unparsable / seq gap）拒绝；
  之后的缺陷容忍为 torn tail（`tornFrom` 标记，load 时物理删除 + 合成
  closers）。

## 合成 closers（崩溃尾部修复）

- **内存合成，不落库**：`interruptedTurnClosers` 在 load 时构造（seq 从
  last.seq+1 续接），只存在于返回的 inspection 视图——不违反「忠实存储」
  不变量，每次 load 幂等合成。
- 合成 closers 无上游 seq：不写 `f_original_seq`（不落库即无此问题）。
- 合成 closers 的 `sourceEventSeqs`（引用 tool/call seq）：稠密坐标（合成
  时已知），读取视图直接携带。

## 上游 cursor 与稠密 head 的关系

- **首次 append（无 seed）**：上游 seq 与稠密 seq 同起点（0），`f_original_seq`
  含瞬时空洞（chunk 不入库）。
- **load / adopt 重建 seed 后**：coordinator 的 cursor 从稠密 seed 尾部续接，
  **此后上游 seq 与稠密 seq 恒等**（新 append 部分）——这是写读对齐的关键
  不变量：WriteGuard 确认的稠密 head 与 coordinator 上游 cursor 通过
  「load 后恒等」对齐。
