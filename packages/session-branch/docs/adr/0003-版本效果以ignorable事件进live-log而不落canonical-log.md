# 0003-版本效果以 ignorable 事件进 live log 而不落 canonical log

分支操作（edit / reroll / retry / fork / rewind）的版本效果记录为
`session-branch/version` 事件，携带 `ignorable: true`：live 会话从内存 log
读到效果（timeline 有完整版本详情），**不落 canonical log**（rdb 持久化时
过滤并稠密化剩余事件），cold 会话的 timeline 只有 lineage 骨架。这样非
branch 读者（token meter、上游投影）可安全跳过版本事件，无需理解分支语义。

## 考虑过的选项

- **版本效果落 canonical log**：上游消费者会看到未知事件类型，需要上游
  配合跳过；且 rewind 截断后重写会产生大量历史噪音。
- **版本效果完全不记录**：timeline 无法展示「编辑了什么、从什么改成什么」。

## 后果

- cold 会话的版本详情不可恢复（只有骨架）——接受：版本详情是 UI 展示
  用途，lineage 骨架足以支撑版本树导航。
- 编排层 push ignorable 事件后必须 `syncLiveCursor` 对齐 coordinator
  cursor，否则后续 append 的 seq 校验错位。
