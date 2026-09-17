# 0005-未闭合轮次原样保留，补 closers 由消费方负责

状态：已采纳

崩溃留下的未闭合尾部（无 turn/end）在 load 时**原样保留**（持久化层不补
合成 closers），补 closers 由消费方（Session 恢复 / agent-loop resume）
负责——与上游 JSONL 语义一致（持久化层原样返回存储事件）。这保持了
「写路径零转换 / 忠实存储」不变量：存储行与 revision 在读取前后完全一致。

## 考虑过的选项

- **load 时物理删除 torn tail + 内存合成 closers**（旧实现）：与上游
  JSONL 语义不一致（上游保留未闭合轮次），且合成 closers 无上游 seq、
  每次 load 幂等合成——复杂度无收益。
- **拒绝加载损坏会话**：用户数据不可用，与上游语义相悖。

## 后果

- 未闭合轮次的真实事件原样保留（`scanRows` 只做 torn tail 检测与 seq gap
  校验）；torn tail（最后一个 turn/end 之后的物理损坏行）读打开只标记，
  物理删除在下一次写 append 时执行。
- 边界校验（rewind / 编辑）用原始事件（`readLog`，不补 closers）——inspect
  会给未闭合 log 补合成 closers，把 user/message 边界掩盖成 turn/end，丢失
  exclusive 语义。
- 与 `balanceRewindPrefix` 的分工：**合法的未闭合尾部保留**（导出 / 导入整段
  日志用 `{ keepOpenTail: true }`，语义就是本 ADR）；**已不平衡的前缀自愈**
  （孤立的 `step/end`、step 号不匹配等在截断 / fork seed 时从配平点起丢弃
  尾部并告警）——后者不是「保留」，是保证下游折叠（token meter）不变量。
  见 [分支能力](../designs/0002-分支能力.md)。
