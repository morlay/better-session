# 0008-崩溃尾部内存合成 closers 而非落库

崩溃留下的未闭合尾部（torn tail）在 load 时**物理删除**，轮次闭合事件
（`interruptedTurnClosers`）在**内存合成**（seq 从 last.seq+1 续接），只
存在于返回的 inspection 视图，不落库——每次 load 幂等合成。这保持了
「写路径零转换 / 忠实存储」不变量：存储行与 revision 在修复前后完全一致。

## 考虑过的选项

- **合成 closers 落库**：违反忠实存储不变量——存储中出现从未真实发生、
  且无上游 seq 的事件；崩溃修复的幂等性也难以保证。
- **拒绝加载损坏会话**：用户数据不可用，且与上游 `commitRepair` 的修复
  语义相悖。

## 后果

- 合成 closers 无上游 seq（不写 `f_original_seq`），其 `sourceEventSeqs`
  是稠密坐标（合成时已知），读取视图直接携带。
- 边界校验（rewind / 编辑）必须用原始事件（`loadStored`，不补 closers）
  ——inspect 会给未闭合 log 补合成 closers，把 user/message 边界掩盖成
  turn/end，丢失 exclusive 语义。
