# 会话编辑

为 DeepSeek Harness 会话提供**就地编辑 / 重试 / 分支**（rewind / retry /
fork）闭环的领域：在不修改上游 `@deepseek-ai/*` 的前提下，重写同一会话或
从闭合边界派生新会话，并投影版本树。契约层 `@morlay/session-branch` →
编排层 `@morlay/ui-conversation-message-actions` → 实现层
`@morlay/session-rdb`；装配决策（rdb 替换官方 jsonl、settings 覆盖）归
聚合层 `@morlay/better-session`。

## 装配

**装配（assembly）**：
把契约 / 编排 / 实现三层一次性装进 DeepSeek Harness web profile 的决策
（`cordis.patch.yml`：禁用官方 jsonl、插入三个插件、settings namespace
覆盖）——归聚合层 `@morlay/better-session`。
_避免使用_：接线、wiring

**rdb 替换（rdb replacement）**：
禁用官方 `session-persistence-jsonl`、用 `@morlay/session-rdb` 实现
`ctx.sessionPersistence`——因为 rewind 需要原子截断，JSONL 顺序介质
提供不了。
_避免使用_：持久化迁移、storage swap

## 会话与编辑

**会话（Session）**：
DeepSeek Harness 中由事件日志 + surface 构成的对话实体，以 session id 标识。
_避免使用_：对话、聊天记录

**就地编辑**：
edit / retry / reroll 的语义：rewind 截断到闭合边界后重写**同一会话**，
session id 不变、版本树保持单根。
_避免使用_：原地修改、in-place

**分支（fork）**：
从任意闭合边界派生**新会话**（纯 append，不触碰源会话）——唯一产生新
session id 的操作。
_避免使用_：复制会话、clone

**轮次（turn）**：
从 `turn/start` 到 `turn/end` 的对话回合，包含一条用户消息与若干助手消息。
_避免使用_：回合、round

**闭合边界（closed boundary）**：
已落定 `turn/end` 的轮次边界——rewind 截断与 fork 派生的唯一合法锚点。
_避免使用_：检查点、checkpoint

**cascade 策略**：
重放范围：`truncate` 只重放目标输入，`preserve` 重放目标及后续全部输入。
_避免使用_：级联、cascade mode

**可编辑块（editable block）**：
可被 edit 修改的已落定文本块：`user` / `assistant.reasoning` /
`assistant.response`。
_避免使用_：消息块、content block

## 版本与血统

**版本效果（version effect）**：
`session-branch/version` 事件，记录一次分支操作（edit / reroll / retry /
fork / rewind）的目标轮次、变更前后文本与逆操作。
_避免使用_：版本事件、变更记录

**ignorable 事件**：
对核心可跳过的事件：live 内存 log 可见、**不进 canonical log**（rdb
持久化时过滤）。
_避免使用_：瞬时事件（瞬时事件是另一概念）

**canonical log**：
会话的持久化事件日志——ignorable 事件不进入，非 branch 读者可安全跳过。
_避免使用_：主日志、持久化日志

**版本树（timeline）**：
由 lineage（`parentSession` + `seedLength`）投影的会话版本树：根为原始
会话，节点为派生 / 编辑后的会话。
_避免使用_：分支图、版本历史

**lineage（血统）**：
会话的祖先链：`parentSession` 指向父会话，`seedLength` 是继承前缀长度。
_避免使用_：家谱、祖先链

**seed（种子）**：
派生会话的初始事件前缀：边界前缀 + 可选 `seedSuffix`（版本效果、手工回合）。
_避免使用_：初始状态、initial state

## 会话状态

**live 会话**：
驻留内存（`ctx.sessions` 有 owner）的会话——rewind 就地截断内存 log 并
同步 coordinator cursor。
_避免使用_：活动会话、打开中的会话

**cold 会话**：
仅持久化、无内存 owner 的会话——rewind 后经 load 重新 adopt。
_避免使用_：离线会话、已关闭会话

**重放（replay）**：
把排队用户输入经 agent `followup` 驱动重放（live 直接排队；cold 先
resume）。
_避免使用_：重生成、regenerate

## 坐标模型

**稠密 seq（dense seq）**：
持久化坐标：幸存事件按持久化计数压缩重编号，连续递增、无空洞。
_避免使用_：持久化 seq、f_sequence

**上游 seq（original seq）**：
事件产生时的 seq（含瞬时事件计数）——读取时经 `f_original_seq →
f_sequence` 映射重映射坐标。
_避免使用_：原始 seq、逻辑 seq

**瞬时事件（transient event）**：
`assistant/chunk` 等不入库的事件——上游 seq 空洞的根源。
_避免使用_：流式事件、chunk 事件

**桥接行（bridge row）**：
`t_session_events` 行：会话专属信息（稠密 seq、上游 seq、surface 元数据）
挂在桥接行，事件实体本身不含会话信息。
_避免使用_：关联行、映射行

**事件行复用（event row reuse）**：
fork 派生会话的桥接行直接引用父会话已存在的事件行，不复制事件行。
_避免使用_：事件共享、行复用

**torn tail**：
崩溃留下的未闭合尾部——load 时物理删除 + 内存合成 closers 修复。
_避免使用_：损坏尾部、残尾

**合成 closers（synthetic closers）**：
load 时内存合成的轮次闭合事件（不落库），修复崩溃尾部。
_避免使用_：虚拟事件、补全事件

**孤儿事件行（orphan event row）**：
无任何桥接行引用的事件行——rewind / 删除后惰性 GC。
_避免使用_：垃圾行、悬空行

**并发写入者（concurrent writer）**：
同一 session id 的第二个写入实例——append 前校验磁盘 head，不一致
fail loud。
_避免使用_：写冲突、写竞争
