# 0006-rewind 绕过 handle 模型直接截断

上游 `SessionHandle` 模型只有 append-only，没有显式回退原语。rewind 直接
操作后端事务：边界校验（闭合 `turn/end` 或 `-1`）→ 事务内截断（删桥接行 +
head 游标回退 + revision bump，Abort 整体回滚）→ 更新 WriteGuard 确认 head
→ live 会话同步（截断内存 log、失效投影缓存、重置 agent 轮次游标、对齐
handle cursor、取消排队输入）。**只删桥接行，事件行保留**（全局实体，可能
被其他会话引用）。

## 考虑过的选项

- **扩展 handle 模型支持回退原语**：违反「上游不可修改」红线。
- **用 append 表达删除**（如 tombstone 事件）：append-only 事件流无法表达
  截断，客户端增量同步会残留旧节点。

## 后果

- rewind 是 rdb 特有的直接截断，未与 handle 模型的 per-id 串行链互斥
  （无法从外部访问）——文档要求对 cold 会话调用（无 live owner、无
  in-flight append）；多实例共享数据库时由事务 + head 校验兜底。
- 截断进入继承前缀时须收缩 `f_seed_length`（只收缩、不扩张），否则存储
  出现「继承前缀超过存储事件数」的矛盾，上游 load 拒绝。
- 保留区 replace range 完整性由数学保证：replace 的 range 引用更早事件，
  截断尾部不可能破坏保留区 range。
- 截断后必须失效 `ctx.sessionProjections` 的单元缓存：投影按 `observedSeq`
  增量驱动，水位停在截断前就永远跳过 seq 回退的重放事件（inbox 投影收不到
  重放输入，agent 只开空轮、不产生模型请求）。
- 截断后必须 durable 取消 agent 的排队输入（`inbox.clear()`，cursor 对齐后
  执行）：落在保留区的 pending 事件不会随截断消失，不取消则 agent 会继续
  处理 rewind 已放弃的输入。
