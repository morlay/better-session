# 旧数据修复（clean & reload）

旧数据（本设计之前的代码写入）的特征：

- `t_events` 带 `f_source_event_seqs` / `f_surface_op` 列（上游坐标 provenance
  落库）；
- `f_original_seq` 在 `t_events`（事件行）而非桥接行；
- `f_kind` 语义为「= 上游 type」（旧）而非「事件种类」（新）。

新格式读取对旧数据**不兼容**（可能 surface 校验失败）。修复分两层：

## 表结构级迁移（一次性脚本）

`scripts/migrate-v1-to-v2.mts`：v1 → v2 表结构迁移（最小变更，事务内）：

1. 建 v2 表（临时名）；
2. 逐行搬运 `t_events`：`f_type` = 旧 `f_kind`，`f_kind`/`f_role`/`f_name`/
   `f_action_id` 经 `eventDimensions` 重算（解析 `f_data`），`f_data` /
   `f_created_at` 原样；
3. 逐行搬运 `t_session_events`：`f_original_seq` / `f_surface_op` 从旧
   `t_events` 对应行取（按 `f_event_id` join）；
4. 删旧表、重命名新表；
5. `user_version` = 2。

用法：`pnpm exec tsx packages/session-rdb/scripts/migrate-v1-to-v2.mts <db-path>`
迁移前请备份数据库文件。已 v2 的库直接返回（no-op）。

## 数据格式级修复（每会话 clean & reload）

表结构已 v2、但数据仍是旧格式（`f_original_seq` 非恒等、`f_surface_op`
上游坐标）时，由服务端 `cleanseSession` 完成（UI 提供 clean & reload 按钮，
见编排层）：

1. 读取会话全部事件行，按旧格式解析（legacy remap 启发式）；
2. 按迁移目标重写（事务内完成——中途失败整体回滚，不留混合格式）：
   - `f_original_seq` 保留（语义 = 上游值，与新格式相同）；
   - `surfaceOp` 迁移到桥接行 `f_surface_op`，保持原始坐标（写路径零转换
     原则——不转稠密坐标，读取时经 `f_original_seq` 映射重映射）；
   - `sourceEventSeqs` 丢弃（不落库语义）；
   - `turn`/`step` 留在 `f_data`（完整原始 data 语义，不剥离）；
   - `f_kind` 重算为事件种类（message/thinking 按 content 块归类）。
3. 客户端 reload 会话历史。

修复是**每会话**操作（按钮在会话头部），不迁移整个数据库。
