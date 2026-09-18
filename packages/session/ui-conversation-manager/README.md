# @morlay/ui-conversation-manager

「对话管理」全局面板页（**浏览器半**）：`sidebar.panellist` nav 行 + `main` keyed 面板（与官方
ui-plugin-manager 同一种注册方式）。页面分两层 Tabs（官方 `Pill`）：一层在**会话**与**统计**之间切换；
会话视图给出全量会话的搜索、分页与归档 / 取消归档 / 导出 / 删除（确认弹窗），并带导入为新会话与
孤儿数据 GC；统计视图给出全部对话的 token 用量。

会话列表取会话目录 ∪ 归档集，按最近活动在前；**已归档**的行带标记，也只有这些行的「删除」可用
（未归档行提供「归档」，两者互斥）。子代理派生会话（`origin: 'subagent'`）默认不列（它们既不可删
也多数无意义，实测在真实库里占七成），勾选「显示子代理会话」即真全量。

统计视图的二层 Tabs 是同一份聚合的四种切法：**总览**（输入 / 输出 / 缓存读取 / 推理 / 合计 / 事件数，
外加「其中子代理」）、**按天**、**按模型**、**按会话**（合计降序取前 20）。

## 用法

页面是 profile 的一行（由 `@morlay/better-session` 的 patch 插入），装好即在侧栏出现「对话管理」。
它不新增 host 面，只读既有服务与路由：

| 动作         | 接缝                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| 列表与标题   | 框架标准座位 `useSessions`（会话目录、标题、时间）+ `useWorkspaces`（工作区归属、归档集）                   |
| 归档         | `ctx.uiWorkspace.archiveSession`（上游 ui-workspace，未归档行提供）                                         |
| 取消归档     | `ctx.uiWorkspace.unarchiveSession`（上游 ui-workspace，已归档行提供）                                       |
| 导出         | `POST /api/session.export`（`@morlay/session-rdb`，直接下载 zip）                                           |
| 删除         | `POST /api/session.delete`（`@morlay/session-rdb`，仅已归档行可用）                                         |
| 导入为新会话 | `POST /api/session.import`（`@morlay/session-rdb`，不带 `sessionId` = 新建会话）                            |
| 清理孤儿数据 | `POST /api/session.gc`（停 agent → 回收孤儿 subagent 会话 → 回收孤儿事件行 → VACUUM；执行期间阻塞界面）     |
| 用量统计     | `POST /api/session.usage`（`@morlay/session-rdb` 读专用用量表聚合；进入统计视图时拉一次，维度切换本地折叠） |

删除、导入与 GC 成功后刷新会话列表（`ctx.sessions.refresh`）；host 拒绝（未归档 / 正在使用 / 不存在）
时按错误码给出可读文案。列表每页 20 条，搜索框复用官方 `Input`（连同官方图标与焦点样式）。

GC 是唯一会**停止所有运行中 agent** 的动作：确认后进入不可关闭的等待弹窗，避免用户在 VACUUM 期间
做别的操作。

## 数据位标注（`data-*`）

页面每个数据位带稳定的 `data-*` 标注，沟通时可以直接指着它说（例如
`data-usage-key=2026-09-14` 那行、`data-session-id=…` 那行的 `data-action=remove`）。
只标"最小身份 + DOM 读不出的状态"：视图/维度由 `data-view`、`data-tab`、`data-usage-tab` 表达，
行内合计与明细、行标题这类页面上直接可见的内容不再重复标注。

统计的列表行与总览格子是**同一套上下布局**（标签小字在上、值大字在下、明细一行），
所以 `data-usage-cell` / `data-usage-value` 与 `data-usage-key` 的读法一致。

| 标注                                                        | 位置               | 含义                                                            |
| ----------------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| `data-view`                                                 | 页面根             | `sessions` / `usage`                                            |
| `data-tab`                                                  | 一层 tab 按钮      | 该按钮切到的视图                                                |
| `data-action`                                               | 按钮               | `import` / `gc` / `archive` / `unarchive` / `export` / `remove` |
| `data-filter`                                               | 过滤器             | `search` / `subagents`                                          |
| `data-session-list` / `data-session-row`                    | 列表与行           | 会话列表、一条会话行                                            |
| `data-session-id` / `data-archived` / `data-subagent`       | 会话行             | 该行的会话 id 与状态（`true` / `false`）                        |
| `data-session-title` / `data-session-meta`                  | 行内字段           | 标题、`工作区 · 时间`                                           |
| `data-pagination` / `data-page-current` / `data-page-total` | 分页条             | 当前页与总页数                                                  |
| `data-notice` / `data-failure` / `data-status`              | 顶部提示与空态     | 结果、错误、`empty` / `empty-search`                            |
| `data-usage-view` / `data-usage-tab`                        | 统计视图与二层 tab | 当前维度（`overview` / `daily` / `models` / `sessions`）        |
| `data-usage-cell` / `data-usage-value`                      | 总览格子           | 维度键与原始数值（未格式化）                                    |
| `data-usage-row` / `data-usage-key`                         | 统计划表行         | 维度键（日期 / `provider / model` / 会话 id / `subagent`）      |
| `data-usage-label` / `data-usage-total` / `data-usage-meta` | 统计行内字段       | 名称、合计、明细                                                |
| `data-usage-status`                                         | 统计状态行         | `loading` / `error` / `empty`                                   |

## 已知限制

- 列表是全量会话：未归档行提供**归档**、已归档行提供**取消归档**（同一位置二选一，互斥）；
  **删除只对已归档会话开放**（未归档行按钮禁用；host 侧仍返回 409），沿用
  [ADR-会话删除仅限已归档且硬删](../session-rdb/.agents/adrs/20260917-会话删除仅限已归档且硬删.md)。
- 只有「最近活动在前」一种排序，没有分组与批量操作；分页是客户端切片（会话目录与标题已在内存）。
- 子代理派生会话默认不列（`origin: 'subagent'`）：勾选「显示子代理会话」后出现并带「子代理」标记，
  但这些行不可删除（它们未归档）；归档 / 取消归档仍可用。
- 没有 summary 的成员（例如已从 host 消失的归档 id）不产生行。
- 删除不再顺带清孤儿：库体积要等一次 GC 才下降，见
  [ADR-删除不再清孤儿与vacuum独立成gc通道](../session-rdb/.agents/adrs/20260918-删除不再清孤儿与vacuum独立成gc通道.md)。
  GC 同时回收**父已不存在的 subagent 会话**（它们是删除父会话后的孤儿）；父还在的子会话不动。
- 导入只接受含会话日志 artifact 的 zip；导出只导出该 artifact（不含附件等旁路数据）。
- 统计是一次全库聚合（真实库实测约 140ms），只在进入统计视图时请求一次；口径见
  [ADR-用量统计走专用用量日志表](../session-rdb/.agents/adrs/20260918-用量统计走专用用量日志表.md)。
  按会话的行是各会话自己的日志口径（fork 子会话含继承前缀），所以各行之和 ≥ 总量；「其中子代理」与另一侧
  相加正好等于总量。
- 统计只反映**库里现有**的用量：删掉的会话与 GC 回收掉的孤儿行都不再计入。

## 文档

- 决策：[ADR-禁用上游已归档入口改由对话管理页承载](../better-session/.agents/adrs/20260918-禁用上游已归档入口改由对话管理页承载.md)
- 测试落点：[`src/__tests__/`](./src/__tests__)（注册面 / 页面 / 注入面 / 数字格式化四条 spec）
