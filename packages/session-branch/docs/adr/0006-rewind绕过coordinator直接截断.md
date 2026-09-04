# 0006-rewind 绕过 coordinator 直接截断

上游 `PersistenceCoordinator` 只有 append-only + torn-tail 修复
（`commitRepair`），没有显式回退原语。rewind 直接操作后端事务：独占校验
（无 live owner，否则 `REWIND_CONFLICT`）→ 边界校验（闭合 `turn/end` 或
`-1`）→ 事务内截断（删桥接行 + head 游标回退 + revision bump，Abort 整体
回滚）→ 同步 coordinator 状态（revision 变化使 `isPreparedSourceCurrent`
失效 → 重新 adopt）→ 更新 WriteGuard 确认 head。**只删桥接行，事件行保留**
（全局实体，可能被其他会话引用）。

## 考虑过的选项

- **扩展 coordinator 支持回退原语**：违反「上游不可修改」红线。
- **用 append 表达删除**（如 tombstone 事件）：append-only 事件流无法表达
  截断，客户端增量同步会残留旧节点。

## 后果

- rewind 是 rdb 特有的直接截断，未与 coordinator 的 per-id 串行链互斥
  （无法从外部访问）——文档要求对 cold 会话调用（无 live owner、无
  in-flight append）；多实例共享数据库时由事务 + head 校验兜底。
- 截断进入继承前缀时须收缩 `f_seed_length`（只收缩、不扩张），否则存储
  出现「继承前缀超过存储事件数」的矛盾，上游 load 拒绝。
- 保留区 replace range 完整性由数学保证：replace 的 range 引用更早事件，
  截断尾部不可能破坏保留区 range。
