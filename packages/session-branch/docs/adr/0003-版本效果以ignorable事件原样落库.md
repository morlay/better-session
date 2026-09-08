# 0003-版本效果以 ignorable 事件原样落库

分支操作（edit / reroll / retry / fork / rewind）的版本效果记录为
`session-branch/version` 事件，携带 `ignorable: true`：live 会话与 canonical
log **一致原样落库**（与上游 JSONL 写路径一致，无过滤），读回时凭 ignorable
信封标记可被非 branch 读者安全跳过（上游 `validateStoredEvents` 对未知类型
fail-closed，ignorable 是唯一豁免）。timeline 因此对 cold 会话也有完整版本
详情。

## 考虑过的选项

- **版本效果不落 canonical log**（旧实现：push 内存 log、rdb 过滤）：
  与上游 JSONL 语义不一致（上游无过滤），且 cold 会话的版本详情不可恢复；
  还需 `syncLiveCursor` 对齐 cursor，复杂度无收益。
- **版本效果完全不记录**：timeline 无法展示「编辑了什么、从什么改成什么」。

## 后果

- 版本效果事件经 RDB write handle 直接落库（带 ignorable 信封），
  `syncLiveCursor` 已删除（落库后 cursor 自然推进）。
- 非 branch 读者（token meter、上游投影）凭 ignorable 标记安全跳过版本
  事件，无需理解分支语义。
