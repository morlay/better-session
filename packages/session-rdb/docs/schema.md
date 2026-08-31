# 数据表设计

命名统一：表一律 `t_` 前缀、字段一律 `f_` 前缀；**实体在 `src/entities/`
纯定义**（每张表一个文件，方言无关的描述；无任何实现逻辑），SQLite
（`sqliteTable`）与 PostgreSQL（`pgTable`）的 drizzle 表对象以及建表 DDL
由 `src/adapters/` 从这些实体转化生成——无手写 DDL、无迁移工具链。除键列外
各表另带 `f_id` serial 自增主键（`t_persistence_state` 以 `f_singleton`、
`t_schema_meta` 以 `f_key` 为键列，无 `f_id`）。**多表关联一律用业务键、
不用 `f_id`**；查询与 join 只走业务键，不为不可达查询维护额外索引。

## SCHEMA_VERSION 与升级

- `SCHEMA_VERSION` 是**破坏性变更门禁**：表结构变更（列增删、列语义变化）
  必须 bump；`openDatabase` 对非当前版本**拒绝打开**（不迁移）。
- 表结构级升级由**一次性迁移脚本**处理（`scripts/migrate-v1-to-v2.mts`，
  重建表 + 数据搬运，可复用 legacy-clean 的解析逻辑）；`clean & reload`
  只处理**同版本内**的数据格式差异（见 [legacy-clean.md](legacy-clean.md)）。
- 本设计相对 v1 的破坏性变更：`t_events` 删 `f_source_event_seqs` /
  `f_surface_op` 列、`f_kind` 语义从「= type」改为「事件种类」、`t_events`
  加 `f_type` 列、`t_session_events` 加 `f_original_seq` / `f_surface_op`
  列——**已 bump 到 v2**。

## PostgreSQL schema 配置

PG 后端支持 `schema` 配置（默认 `public`）：

```yaml
session-rdb:
  type: postgres
  connectionString: postgres://user:pass@host:5432/db
  schema: sessions   # 显式 schema，默认 public
```

- 表对象经 `pgSchema(name).table` 构建——查询与 DDL 都**显式 schema 限定**，
  不依赖 `search_path`。
- schema 必须已存在（或连接角色可创建）；后端不自动创建。
- `identityBase`（revision 前缀）含 schema，不同 schema 的 store 身份隔离。

## 元数据表

| 表 | 键 | 说明 |
| --- | --- | --- |
| `t_sessions` | `f_session_id` UNIQUE | 会话元数据（`SessionHeader` 列：`f_version` / `f_created_at` / `f_cwd` / `f_parent_session` / `f_seed_length` / `f_origin` / `f_delegation_depth`）+ head 游标（`f_head_event_id` / `f_head_sequence`，事务内维护，append 时提供 parent 链与下一个 seq）+ materialization 身份（`f_incarnation` / `f_revision`）。行的存在即 materialized 信号 |
| `t_persistence_state` | `f_singleton` | store 身份单例（`f_store_id`） |
| `t_schema_meta` | `f_key` | PG 专用：schema 版本 / 应用身份键值对（SQLite 用 `PRAGMA user_version` / `application_id`） |

## 事件实体表（全局，忠实存储原始事件）

**`t_events`** — 全局可寻址的持久化事件实体：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `f_id` | serial PK | 自增主键（仅存储内部） |
| `f_event_id` | text UNIQUE | UUID，全局唯一事件身份 |
| `f_parent_id` | text | 事件链（空串为 root；fork 复用事件行时子会话桥接行共享同一链） |
| `f_type` | text | 上游 `SessionEvent.type`（如 `user/message`、`turn/start`） |
| `f_kind` | text | 事件种类（message / thinking / turn / tool / request / config / audit / lifecycle / inbox / compaction / llm / subagent / team / workflow / goal / schedule / todo / web，见下） |
| `f_role` | text | 对话角色（user / assistant / tool / turn，见下） |
| `f_name` / `f_action_id` | text | 事件名称 / 配对 id（见下） |
| `f_encoding` | text | `json` |
| `f_data` | text | JSON 文本，**完整原始 data**（含 `turn`/`step` 轮次坐标、`shadowedRange` 原始坐标）——忠实存储，读取时按需 drop 或重映射 |
| `f_created_at` | bigint | 上游 `SessionEvent.time` |

**不含**：`sourceEventSeqs`（不落库，读取时按需重计算）、`surfaceOp`（会话
专属，在桥接行）。

### 事件维度（f_kind / f_role / f_name / f_action_id）

四列从事件分类提取，覆盖全部已知事件类型（未知插件扩展类型保持空值）。

**`f_kind`** — 事件种类（粗分类，查询过滤用）：

| kind | 事件类型 |
| --- | --- |
| `message` | `user/message` / `assistant/message`（content 无 reasoning 块） |
| `thinking` | `assistant/message`（content 含 reasoning 块） |
| `turn` | `turn/start` / `turn/end` / `step/start` / `step/end` / `session/end-seed` |
| `tool` | `tool/call` / `tool/result` / `tool/code-dispatch-start` / `tool/code-dispatch` |
| `request` | `request/header` / `request/context` |
| `config` | `model/selection` / `permission/preset` / `approval/policy` / `sandbox/mode` / `plan/mode` / `agent-preset/selected` |
| `audit` | `approval/asked` / `approval/decided` / `command/run` / `command/done` / `hook/invoked` / `hook/result` / `feedback/record` |
| `lifecycle` | `session/title` / `session/title-llm-request` / `session-log-deepseek/delivery-accepted` |
| `inbox` | `agent/inbox/spliced` |
| `compaction` | `compaction/start` / `compaction/end` / `compaction/summary` / `compaction/prune` |
| `llm` | `llm/retry` / `llm/retry-started` |
| `subagent` | `subagent/descriptor` / `subagent/model-selection-policy` |
| `team` | `team/member` / `team/task` / `team/message/queued` / `team/message/delivered` |
| `workflow` | `tool-workflow/run-start` / `tool-workflow/run-end` / `tool-workflow/agent-start` / `tool-workflow/agent-end` |
| `goal` | `goal/change` |
| `schedule` | `schedule/change` |
| `todo` | `todo/write` |
| `web` | `web/deepseek-search-llm-request` |
| （空） | 未知插件扩展类型 |

**message/thinking 归类规则（确定性）**：`assistant/message` 的 content 是
块数组（`ContentBlock[]`，可混合 reasoning / text / tool-call 等）。归类规则：
**content 含任一 `reasoning` 块 → `thinking`；否则 → `message`**。空 content
→ `message`。规则在写路径执行（`eventDimensions`），落库后不可重算——规则
冻结后不得变更。

**`f_role`** — 对话角色（消息类事件的发言方；非消息事件为空）：

| role | 事件类型 |
| --- | --- |
| `user` | `user/message` |
| `assistant` | `assistant/message` |
| `tool` | `tool/result` |
| （空） | 其余事件（turn/step 边界、request / config / audit / lifecycle / …） |

**`f_name`** — 事件的具体名称（有名称字段的事件）：

| 事件 | f_name |
| --- | --- |
| `tool/call` | `data.name`（工具名） |
| `command/run` | `data.name`（命令名） |
| `todo/write` | `todos` |
| `subagent/descriptor` | 子会话 label（如有） |
| 其余 | 空 |

**`f_action_id`** — 配对 id（跨事件关联键，字符串 id 不引用 seq）：

| 事件 | f_action_id |
| --- | --- |
| `tool/call` | `data.callId` |
| `tool/result` | `data.message.content[0].toolCallId` |
| `tool/code-dispatch-start` / `tool/code-dispatch` | `data.subCallId` |
| `command/run` / `command/done` | `data.commandId` |
| `approval/asked` / `approval/decided` | `data.id` |
| `hook/invoked` / `hook/result` | `data.handlerId` |
| `llm/retry` / `llm/retry-started` | `data.retryId` |
| `tool-workflow/run-start` / `run-end` / `agent-start` / `agent-end` | `data.runId` |
| 其余 | 空 |

### 索引

| 表 | 索引 | 说明 |
| --- | --- | --- |
| `t_events` | `f_event_id` UNIQUE | 事件身份（join 查找侧 + 事件行复用去重） |
| `t_events` | `f_kind` | 按事件种类查询（审计 / UI 过滤） |
| `t_events` | `f_role` | 按对话角色查询（消息流过滤） |
| `t_events` | `f_name` | 按事件名称查询（工具名 / 命令名过滤） |
| `t_events` | `f_action_id` | 按配对 id 查询（跨事件关联：callId / commandId / runId 等） |
| `t_session_events` | `UNIQUE(f_session_id, f_sequence)` | 会话内事件顺序（覆盖按 session 过滤 + seq 范围/排序/取尾） |
| `t_session_events` | `f_event_id` | 反向查找（按事件找会话；孤儿事件行清理） |

## 会话桥接表（session 专属信息）

**`t_session_events`** — 会话↔事件桥接：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `f_id` | serial PK | 自增主键（仅存储内部） |
| `f_session_id` | text FK → `t_sessions.f_session_id` (CASCADE) | 会话 |
| `f_event_id` | text FK → `t_events.f_event_id` (CASCADE) | 事件实体（可被多会话引用） |
| `f_sequence` | integer | **稠密持久化 seq**（连续递增、无空洞） |
| `f_original_seq` | integer | **上游 seq**（事件产生时的 seq，含瞬时事件计数）——重映射查阅：读取时构建 `f_original_seq → f_sequence` 映射，把 `shadowedRange` / replace range 从上游坐标重映射到稠密坐标 |
| `f_surface_op` | text | surface 元数据（`append` / `replace`，JSON 文本，**原始坐标**——replace 的 range 是上游 seq，读取时重映射；非 surface 事件为 NULL） |

约束：`UNIQUE(f_session_id, f_sequence)`（自动建唯一索引，覆盖全部访问模式：
按 session 过滤 + 按 seq 范围/排序/取尾）。

**孤儿事件行清理**：rewind / torn-tail 物理删除 / 会话删除（CASCADE 删桥接行）
后，无任何桥接行引用的 `t_events` 行成为孤儿。清理策略：

- **惰性 GC**：`cleanseSession`（每会话修复）顺带删除该会话不再引用的孤儿
  事件行（`DELETE FROM t_events WHERE f_event_id NOT IN (SELECT f_event_id
  FROM t_session_events)`，经 `t_session_events.f_event_id` 索引）；
- 不做全局定时 GC（多实例共享数据库时跨实例引用不可知，惰性清理只处理
  本会话可见的孤儿）。

**session 专属信息清单**（全部在桥接行，事件实体不关心）：

| 信息 | 列 | 说明 |
| --- | --- | --- |
| 稠密 seq | `f_sequence` | 会话内事件顺序 |
| 上游 seq | `f_original_seq` | 重映射查阅（上游→稠密映射） |
| surface 元数据 | `f_surface_op` | 事件进入 surface 的方式（append / replace，原始坐标） |
