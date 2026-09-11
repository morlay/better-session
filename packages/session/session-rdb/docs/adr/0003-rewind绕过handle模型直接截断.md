# 0003-rewind 绕过 handle 模型直接截断

上游 `SessionHandle` 模型只有 append-only，没有显式回退原语。rewind 直接
操作后端事务：边界校验（闭合 `turn/end`、`user/message` 排除式截断，或
`-1` 空前缀）→ 事务内截断（删桥接行 +
head 游标回退 + revision bump，Abort 整体回滚）→ 更新 WriteGuard 确认 head
→ live 会话同步（截断内存 log、失效投影缓存、重置 agent 轮次游标、对齐
handle cursor、取消排队输入）→ 刷新持久化投影检查点。**只删桥接行，事件行
保留**（全局实体，可能被其他会话引用）。

## 考虑过的选项

- **扩展 handle 模型支持回退原语**：违反「上游不可修改」红线。
- **用 append 表达删除**（如 tombstone 事件）：append-only 事件流无法表达
  截断，客户端增量同步会残留旧节点。

## 后果

- rewind 是 rdb 特有的直接截断，未与 handle 模型的 per-id 串行链互斥
  （无法从外部访问）；live 与 cold 会话都支持，调用方需保证该会话没有
  in-flight append；多实例共享数据库时由事务 + head 校验兜底。
- 截断进入继承前缀时须收缩 `f_seed_length`（只收缩、不扩张），否则存储
  出现「继承前缀超过存储事件数」的矛盾，上游 load 拒绝。
- 保留区 replace range 完整性由数学保证：replace 的 range 引用更早事件，
  截断尾部不可能破坏保留区 range。
- 截断后必须同步的派生状态（投影单元缓存失效、agent 排队输入 durable 取消、
  持久化投影检查点刷新）与 fail-soft 语义见
  [branch.md](../branch.md) 的 rewind 步骤；漏掉任一项会让被截断的历史在
  读取侧重现或重放错乱。
