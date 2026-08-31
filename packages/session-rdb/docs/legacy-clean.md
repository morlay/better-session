# 旧数据修复（clean & reload）

旧数据（本设计之前的代码写入）的特征：

- `t_events` 带 `f_source_event_seqs` / `f_surface_op` 列（上游坐标 provenance
  落库）；
- `f_original_seq` 在 `t_events`（事件行）而非桥接行；
- `f_kind` 语义为「= 上游 type」（旧）而非「事件种类」（新）。

新格式读取对旧数据**不兼容**（可能 surface 校验失败）。修复由服务端
`cleanseSession` 完成（UI 提供 clean & reload 按钮，见编排层）。

## 迁移目标（与新格式一致）

1. **`f_original_seq` 保留**（旧数据语义 = 上游值，与新格式相同）——从
   `t_events` 迁移到 `t_session_events` 桥接行；
2. **`surfaceOp` 迁移到桥接行 `f_surface_op`，保持原始坐标**（写路径零转换
   原则——不转稠密坐标，读取时经 `f_original_seq` 映射重映射）；
3. **`sourceEventSeqs` 丢弃**（不落库语义）；
4. **`turn`/`step` 留在 `f_data`**（完整原始 data 语义，不剥离）；
5. **`f_kind` 重算**为事件种类（message/thinking 按 content 块归类）。

## 流程

1. 读取会话全部事件行，按旧格式解析（legacy remap 启发式）；
2. 按上述迁移目标重写（事务内完成——中途失败整体回滚，不留混合格式）；
3. 客户端 reload 会话历史。

## 约束

- 修复是**每会话**操作（按钮在会话头部），不迁移整个数据库。
- **表结构不兼容时 clean 按钮不可达**（打开会话即失败）——表结构级变更
  由 SCHEMA_VERSION bump + 一次性迁移脚本处理（见 [schema.md](schema.md)），
  clean & reload 只处理**同版本内**的数据格式差异。
- 失败恢复：迁移事务回滚后会话保持旧格式，可重试。
