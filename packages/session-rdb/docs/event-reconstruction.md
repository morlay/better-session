# 事件 id 关联与重建可行性分析

本文件系统梳理上游 `SessionEventMap` 全部事件类型的 **id 关联**（跨事件配对 /
seq 引用），验证「事件实体无 session 信息 + 桥接行存轮次坐标 + sourceEventSeqs
不落库」的设计能否完整重建会话。

## 结论摘要

- **所有 id 配对事件**（`commandId` / `approvalId` / `callId` / `retryId` /
  `runId` / `subCallId` / `handlerId`）都是**自包含 id**，不引用 seq——重建
  安全，与坐标无关。
- **seq 引用事件**分三类：
  - 引用**不入库的 chunk**（`assistant/message.sourceEventSeqs`）→ 丢弃安全
    （token-meter 重放时引用不存在的 chunk 会抛错，验证了丢弃的必要性）。
  - 引用**持久化事件的展示性引用**（`command/done.sourceEventSeq`、
    `session/title.messageSeqs`）→ 稠密坐标下仍成立（引用的都是持久化事件，
    seq 是稠密坐标）。
  - 引用**持久化 surface 节点的强校验引用**（replace 的 `sourceEventSeqs`、
    `compaction/summary.shadowedRange`）→ 读取时经 `f_original_seq` 映射
    重映射到稠密坐标（见 [read-path.md](read-path.md)）。

**坐标转换集中在读取路径**：`t_events.f_data` 存完整原始 data（含
turn/step、shadowedRange 原始坐标），`t_session_events.f_surface_op` 存
原始坐标的 surfaceOp，`f_original_seq` 提供上游→稠密映射——读取时按需
drop（`sourceEventSeqs`）或重映射（replace range / shadowedRange），无
启发式。fork 前缀经 `inspect` 读取视图（已重映射到父稠密坐标），重编号后
子会话坐标与父稠密坐标数值相同，无需额外重映射（见 [branch.md](branch.md)）。

## 事件类型清单

### 轮次边界事件（turn/step，data 完整落库）

| 事件 | data（上游，完整落库） | 说明 |
| --- | --- | --- |
| `turn/start` | `{ turn }` | 自包含 |
| `turn/end` | `{ turn, reason }` | 自包含 |
| `step/start` | `{ turn, step }` | 自包含 |
| `step/end` | `{ turn, step }` | 自包含 |

重建：`f_data` 完整保留 turn/step，读取时无需注入。轮次配对（turn/start ↔
turn/end、step/start ↔ step/end）由事件顺序 + 坐标保证，无跨事件 id 引用。

### surface 消息事件（user/assistant/tool，桥接行存 surfaceOp）

| 事件 | data（上游，完整落库） | 桥接行 | id 关联 |
| --- | --- | --- | --- |
| `user/message` | `UserMessage`（含 `id`） | `f_surface_op` | 消息 `id` 自包含（inbox 配对用，见下） |
| `assistant/message` | `{ turn, step, message, usage?, interrupted? }` | `f_surface_op` | `sourceEventSeqs` 引用 chunk → **读取时丢弃** |
| `tool/result` | `{ turn, step, message, error?, meta? }` | `f_surface_op` | `message.source.callId` 配对 `tool/call`；`sourceEventSeqs` 引用 `tool/call` → **读取时丢弃** |

**replace 事件**（`surfaceOp: { op: "replace", start, end }`，桥接行存原始
坐标）：读取时经 `f_original_seq` 映射把 range 重映射到稠密坐标，并**重计算**
`sourceEventSeqs` = range 内（稠密坐标）全部 surface 节点 seq 集合——满足
上游 `assertProvenance` 的 shadowed 覆盖硬校验（见
[read-path.md](read-path.md)）。

### 工具调用配对（tool/call ↔ tool/result）

| 事件 | data | id 关联 |
| --- | --- | --- |
| `tool/call` | `{ turn, step, callId, name, arguments }` | `callId` 自包含 |
| `tool/result` | `{ turn, step, message, error?, meta? }` | `message.source.callId` 配对 `tool/call` |

配对按 `callId`（字符串 id），不引用 seq——重建安全。`tool/result` 的
`sourceEventSeqs`（引用 `tool/call` 的 seq）丢弃：上游对 append 只校验合法
性（引用更早、无重复），无消费者依赖其内容。

### 生命周期配对事件（自包含 id，重建安全）

| 事件对 | 配对键 | 说明 |
| --- | --- | --- |
| `command/run` ↔ `command/done` | `commandId` | `command/done.sourceEventSeq` 是**展示性引用**（指向 compaction/summary 的 seq，UI 跳转用）——稠密坐标下仍成立（引用的都是持久化事件） |
| `approval/asked` ↔ `approval/decided` | `id` | 审计配对 |
| `hook/invoked` ↔ `hook/result` | `handlerId` + `point` | 钩子执行配对 |
| `llm/retry` ↔ `llm/retry-started` | `retryId` | 重试调度配对 |
| `tool-workflow/run-start` ↔ `agent-start` ↔ `agent-end` ↔ `run-end` | `runId` + `seq` | 工作流成员配对 |
| `tool/code-dispatch-start` ↔ `tool/code-dispatch` | `subCallId` | 子调用配对 |

全部按**字符串 id** 配对，不引用 seq——重建安全，与坐标无关。

### 自包含状态事件（无跨事件引用）

| 事件 | data | 说明 |
| --- | --- | --- |
| `agent/inbox/spliced` | `{ target, start, removedCount?, inserted, outcome? }` | 自包含（inbox 投影按事件顺序重放） |
| `subagent/descriptor` | 子会话身份 | 自包含 |
| `goal/change` | `{ id, revision, ... }` | 自包含（goal 投影按事件顺序折叠） |
| `schedule/change` | 调度变更 | 自包含 |
| `feedback/record` | `{ text }` | 自包含 |
| `request/header` / `request/context` | 请求头 / 路由 | 自包含（fold 按事件顺序） |
| `model/selection` / `permission/preset` / `approval/policy` / `sandbox/mode` / `plan/mode` / `agent-preset/selected` | 配置快照 | 自包含（last-wins 折叠） |
| `session/end-seed` | `{}` | 自包含（seed 边界标记） |
| `todo/write` | todo 状态 | 自包含 |
| `session/title` | `{ title, messageSeqs, source }` | `messageSeqs` 是**展示性引用**（标题来源消息 seq，UI 展示用）——稠密坐标下仍成立（引用的都是持久化 user/message）；invariant 只校验「自动标题非空」 |
| `session/title-llm-request` | `{ titleProvider, messageSeqs, route, system, messages, maxTokens }` | log-only 请求记录，无重建消费者 |
| `session-log-deepseek/delivery-accepted` | `{ sessionId, throughSeq }` | log-only 投递记录 |
| `web/deepseek-search-llm-request` | 搜索请求记录 | log-only |
| `feedback/record` | `{ text }` | 自包含 |

### compaction 事件（shadowedRange 读取时重映射）

| 事件 | data | 说明 |
| --- | --- | --- |
| `compaction/start` / `compaction/end` | `{ turn }` | 自包含 |
| `compaction/summary` / `compaction/prune` | `{ turn, summary, shadowedRange, shadowedTokenCount }` | `shadowedRange` 引用被 replace 覆盖的 surface 节点范围（上游 seq，完整落库）→ **读取时经 `f_original_seq` 映射重映射到稠密坐标**（与 replace range 同空间，token-meter 折叠正常消费） |

## 重建验证矩阵

| 场景 | 设计是否满足 | 说明 |
| --- | --- | --- |
| 完整 log 重放（load → `Session.create(seed)`） | ✅ | seq 稠密连续；f_data 完整（turn/step 原样）；replace range / shadowedRange 经 `f_original_seq` 映射重映射；replace 重计算 provenance |
| fork 派生（复用事件行） | ✅ | `inspect` 返回读取视图（replace range 已重映射到父稠密坐标），前缀重编号后子会话 seq 与父稠密 seq 数值相同——无需额外坐标重映射；桥接行 `f_original_seq` 是子会话自己的上游空间（不复制父值）；事件行共享 |
| fork 后 rewind | ✅ | 子会话只删桥接行、事件行保留（父会话仍引用）；保留区 replace range 完整性不变量成立（见 [branch.md](branch.md)） |
| rewind 截断 | ✅ | 只删桥接行；保留区 replace 重映射从保留 log 取，天然一致（range 引用更早事件 ⇒ 截断尾部不破坏保留区 range） |
| token-meter 重放 | ✅ | `assistant/message` 无 sourceEventSeqs（chunk 引用已丢弃）→ 走 durable 估算路径，不抛错 |
| compaction 后重放 | ✅ | `shadowedRange` 与紧随 replace range 经同一映射重映射到稠密坐标，同空间（"no adjacent shadow price" 契约成立） |
| 命令/审批/钩子/重试/工作流配对 | ✅ | 全部按字符串 id 配对，与坐标无关 |
| 标题展示 | ✅ | `messageSeqs` 引用持久化 user/message，稠密坐标下仍成立 |
| 崩溃尾部修复 | ✅ | scanRows 语义不变（稠密连续）；合成 closers 内存合成不落库（见 [read-path.md](read-path.md)） |
| HMR adopt | ✅ | adopt 前 load 稠密重建（live seed 与存储同坐标，`seedCoversPrefix` 的 JSON 相等比较成立） |
| subagent 子会话 | ✅ | 独立会话独立映射，无特殊风险 |
| 多实例 loadStored 重建映射 | ✅ | 另一实例 loadStored 重建 `f_original_seq → f_sequence` 映射后 append，走「load 后恒等」（见 [read-path.md](read-path.md)） |
| legacy clean 后重放 | ✅ | 迁移目标与新格式一致（保留 f_original_seq、surfaceOp 原始坐标、turn/step 留 f_data），clean 后读取恒等（见 [legacy-clean.md](legacy-clean.md)） |
