# 事件 id 关联与重建可行性分析

本文件系统梳理上游 `SessionEventMap` 全部事件类型的 **id 关联**（跨事件配对 /
seq 引用），验证「事件实体无 session 信息 + 桥接行存 surface 元数据 +
sourceEventSeqs 不落库」的设计能否完整重建会话。

## 结论摘要

- **所有 id 配对事件**（`commandId` / `approvalId` / `callId` / `retryId` /
  `runId` / `subCallId` / `handlerId`）都是**自包含 id**，不引用 seq——重建
  安全，与坐标无关。
- **seq 引用事件**分两类：
  - 引用**持久化事件的展示性引用**（`command/done.sourceEventSeq`、
    `session/title.messageSeqs`）→ 稠密坐标下仍成立（引用的都是持久化事件，
    seq 即稠密坐标）。
  - 引用**持久化 surface 节点的强校验引用**（replace 的 `sourceEventSeqs`、
    `compaction/summary.shadowedRange`）→ 读取时重计算 / 原样消费（见
    [read-path.md](read-path.md)）。
- **原样存储、原样读取**：`t_events.f_data` 存完整事件（含 ignorable 信封），
  事件 seq 即稠密 seq，无坐标映射；`sourceEventSeqs` 不落库，replace 的
  provenance 读取时重计算（优先权威 shadowedSeqs，回退 range 扫描）。fork
  前缀经 `readLog` 读取视图（已是稠密坐标），重编号后子会话坐标与父稠密
  坐标数值相同，无需额外重映射（见 [branch.md](branch.md)）。

## 事件类型清单

### 轮次边界事件（turn/step，data 完整落库）

| 事件         | data（上游，完整落库） | 说明   |
| ------------ | ---------------------- | ------ |
| `turn/start` | `{ turn }`             | 自包含 |
| `turn/end`   | `{ turn, reason }`     | 自包含 |
| `step/start` | `{ turn, step }`       | 自包含 |
| `step/end`   | `{ turn, step }`       | 自包含 |

重建：`f_data` 完整保留 turn/step，读取时无需注入。轮次配对（turn/start ↔
turn/end、step/start ↔ step/end）由事件顺序 + 坐标保证，无跨事件 id 引用。

### surface 消息事件（user/assistant/tool，桥接行存 surfaceOp）

| 事件                | data（上游，完整落库）                          | 桥接行         | id 关联                                                                             |
| ------------------- | ----------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `user/message`      | `UserMessage`（含 `id`）                        | `f_surface_op` | 消息 `id` 自包含（inbox 配对用，见下）                                              |
| `assistant/message` | `{ turn, step, message, usage?, interrupted? }` | `f_surface_op` | 无 seq 引用（上游禁止 `sourceEventSeqs`，流式 delta 嵌入 `stream`）                 |
| `tool/result`       | `{ turn, step, message, error?, meta? }`        | `f_surface_op` | `message.source.callId` 配对 `tool/call`；无 seq 引用（上游禁止 `sourceEventSeqs`） |

**replace 事件**（`surfaceOp: { op: "replace", startSeq, endSeq }`，桥接行原样存）：
读取时**重计算** `sourceEventSeqs`——优先取紧邻 metering 事件
（`compaction/summary` / `compaction/prune`）的 `shadowedSeqs`（权威被遮蔽
节点列表），无 metering 事件时回退为 range 内全部 surface 节点 seq 集合——
满足上游 `assertProvenance` 的 shadowed 覆盖硬校验（见
[read-path.md](read-path.md)）。

### 工具调用配对（tool/call ↔ tool/result）

| 事件          | data                                      | id 关联                                  |
| ------------- | ----------------------------------------- | ---------------------------------------- |
| `tool/call`   | `{ turn, step, callId, name, arguments }` | `callId` 自包含                          |
| `tool/result` | `{ turn, step, message, error?, meta? }`  | `message.source.callId` 配对 `tool/call` |

配对按 `callId`（字符串 id），不引用 seq——重建安全。

### 生命周期配对事件（自包含 id，重建安全）

| 事件对                                                              | 配对键                | 说明                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `command/run` ↔ `command/done`                                      | `commandId`           | `command/done.sourceEventSeq` 是**展示性引用**（指向 compaction/summary 的 seq，UI 跳转用）——稠密坐标下仍成立（引用的都是持久化事件） |
| `approval/asked` ↔ `approval/decided`                               | `id`                  | 审计配对                                                                                                                              |
| `hook/invoked` ↔ `hook/result`                                      | `handlerId` + `point` | 钩子执行配对                                                                                                                          |
| `llm/retry` ↔ `llm/retry-started`                                   | `retryId`             | 重试调度配对                                                                                                                          |
| `tool-workflow/run-start` ↔ `agent-start` ↔ `agent-end` ↔ `run-end` | `runId` + `seq`       | 工作流成员配对                                                                                                                        |
| `tool/code-dispatch-start` ↔ `tool/code-dispatch`                   | `subCallId`           | 子调用配对                                                                                                                            |

全部按**字符串 id** 配对，不引用 seq——重建安全，与坐标无关。

### 自包含状态事件（无跨事件引用）

| 事件                                                                                                                 | data                                                                 | 说明                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/inbox/spliced`                                                                                                | `{ target, start, removedCount?, inserted, outcome? }`               | 自包含（inbox 投影按事件顺序重放）                                                                                                                 |
| `subagent/descriptor`                                                                                                | 子会话身份                                                           | 自包含                                                                                                                                             |
| `goal/change`                                                                                                        | `{ id, revision, ... }`                                              | 自包含（goal 投影按事件顺序折叠）                                                                                                                  |
| `schedule/change`                                                                                                    | 调度变更                                                             | 自包含                                                                                                                                             |
| `feedback/record`                                                                                                    | `{ text }`                                                           | 自包含                                                                                                                                             |
| `request/header` / `request/context`                                                                                 | 请求头 / 路由                                                        | 自包含（fold 按事件顺序）                                                                                                                          |
| `model/selection` / `permission/preset` / `approval/policy` / `sandbox/mode` / `plan/mode` / `agent-preset/selected` | 配置快照                                                             | 自包含（last-wins 折叠）                                                                                                                           |
| `session/end-seed`                                                                                                   | `{}`                                                                 | 自包含（seed 边界标记）                                                                                                                            |
| `todo/write`                                                                                                         | todo 状态                                                            | 自包含                                                                                                                                             |
| `session/title`                                                                                                      | `{ title, messageSeqs, source }`                                     | `messageSeqs` 是**展示性引用**（标题来源消息 seq，UI 展示用）——稠密坐标下仍成立（引用的都是持久化 user/message）；invariant 只校验「自动标题非空」 |
| `session/title-llm-request`                                                                                          | `{ titleProvider, messageSeqs, route, system, messages, maxTokens }` | log-only 请求记录，无重建消费者                                                                                                                    |
| `session-log-deepseek/delivery-accepted`                                                                             | `{ sessionId, throughSeq }`                                          | log-only 投递记录                                                                                                                                  |
| `web/deepseek-search-llm-request`                                                                                    | 搜索请求记录                                                         | log-only                                                                                                                                           |

### compaction 事件（shadowedSeqs 读取时消费）

| 事件                                      | data                                                                 | 说明                                                                                                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compaction/start` / `compaction/end`     | `{ turn }`                                                           | 自包含                                                                                                                                                                                                                                                         |
| `compaction/summary` / `compaction/prune` | `{ turn, summary, shadowedRange, shadowedSeqs, shadowedTokenCount }` | `shadowedRange` / `shadowedSeqs` 引用被 replace 覆盖的 surface 节点（原样落库，seq 即稠密坐标，token-meter 折叠正常消费）；`shadowedSeqs` 是权威被遮蔽节点列表（range 只是首尾边界对，压缩竞态下可能漏掉并发落地的节点），replace 的 provenance 重计算以它为准 |

## 重建验证矩阵

| 场景                                           | 设计是否满足 | 说明                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整 log 重放（load → `Session.create(seed)`） | ✅           | seq 稠密连续；f_data 完整（turn/step 原样）；replace 重计算 provenance（优先 shadowedSeqs，回退 range 扫描）                                                                                         |
| fork 派生（复用事件行）                        | ✅           | `readLog` 返回读取视图（已是稠密坐标），前缀重编号后子会话 seq 与父稠密 seq 数值相同——无需额外坐标重映射；桥接行 `f_sequence` 是子会话自己的上游空间（不复制父值）；事件行共享                       |
| fork 后 rewind                                 | ✅           | 子会话只删桥接行、事件行保留（父会话仍引用）；保留区 replace range 完整性不变量成立（见 [branch.md](branch.md)）                                                                                     |
| rewind 截断                                    | ✅           | 只删桥接行；保留区 replace 重计算从保留 log 取，天然一致（range 引用更早事件 ⇒ 截断尾部不破坏保留区 range）                                                                                          |
| token-meter 重放                               | ✅           | `assistant/message` 无 `sourceEventSeqs`（v2 禁止）→ 走 durable 估算路径，不抛错                                                                                                                     |
| compaction 后重放                              | ✅           | `shadowedRange` 与紧随 replace range 同空间（当前写入器保证）；旧坐标残留由读取视图重写 metering range 对齐，"no adjacent shadow price" 契约成立                                                     |
| 命令/审批/钩子/重试/工作流配对                 | ✅           | 全部按字符串 id 配对，与坐标无关                                                                                                                                                                     |
| 标题展示                                       | ✅           | `messageSeqs` 引用持久化 user/message，稠密坐标下仍成立                                                                                                                                              |
| 崩溃尾部修复                                   | ✅           | scanRows 语义不变（稠密连续）；未闭合轮次原样保留，补 closers 由消费方负责（见 [read-path.md](read-path.md)）                                                                                        |
| HMR adopt                                      | ✅           | adopt 前 readLog 稠密重建（live seed 与存储同坐标，`seedCoversPrefix` 的 JSON 相等比较成立）                                                                                                         |
| subagent 子会话                                | ✅           | 独立会话独立坐标，无特殊风险                                                                                                                                                                         |
| 多实例 open 重建                               | ✅           | 另一实例 open 读取存储事件后 append，走「原样存储恒等」（见 [read-path.md](read-path.md)）                                                                                                           |
| 导出（readRaw）后重放                          | ✅           | 读取/导出视图修复：修复 surface 语义（非法 replace 夹取或降级 append、metering range 对齐）并重算 provenance，artifact 完备可用——导入后无需任何修复即可加载（见 [legacy-clean.md](legacy-clean.md)） |
| 混合世代旧 log（旧写入器跨版本追加）           | ✅           | 迁移链拒绝后回退为当前格式视图：header 版本归一、补 `stream`、越界 replace 按 metering 数量夹取（见 [legacy-clean.md](legacy-clean.md)）                                                             |
