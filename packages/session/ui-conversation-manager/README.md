# @morlay/ui-conversation-manager

「对话管理」全局面板页（**浏览器半**）：`sidebar.panellist` nav 行 + `main` keyed 面板（与官方
ui-plugin-manager 同一种注册方式），在一页上给出**全量会话**的搜索与分页，以及取消归档、导出、
删除（确认弹窗）、导入为新会话与孤儿数据 GC。列表取会话目录 ∪ 归档集，按最近活动在前；**已归档**
的行带标记，也只有这些行的「取消归档 / 删除」可用。子代理派生会话（`origin: 'subagent'`）默认不列
（它们既不可删也不可取消归档，实测在真实库里占七成），勾选「显示子代理会话」即真全量。

## 用法

页面是 profile 的一行（由 `@morlay/better-session` 的 patch 插入），装好即在侧栏出现「对话管理」。
它不新增 host 面，只读既有服务与路由：

| 动作         | 接缝                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| 列表与标题   | 框架标准座位 `useSessions`（会话目录、标题、时间）+ `useWorkspaces`（工作区归属、归档集）               |
| 归档         | `ctx.uiWorkspace.archiveSession`（上游 ui-workspace，未归档行提供）                                     |
| 取消归档     | `ctx.uiWorkspace.unarchiveSession`（上游 ui-workspace，已归档行提供）                                   |
| 导出         | `POST /api/session.export`（`@morlay/session-rdb`，直接下载 zip）                                       |
| 删除         | `POST /api/session.delete`（`@morlay/session-rdb`，仅已归档行可用）                                     |
| 导入为新会话 | `POST /api/session.import`（`@morlay/session-rdb`，不带 `sessionId` = 新建会话）                        |
| 清理孤儿数据 | `POST /api/session.gc`（停 agent → 回收孤儿 subagent 会话 → 回收孤儿事件行 → VACUUM；执行期间阻塞界面） |

删除、导入与 GC 成功后刷新会话列表（`ctx.sessions.refresh`）；host 拒绝（未归档 / 正在使用 / 不存在）
时按错误码给出可读文案。列表每页 20 条，搜索框复用官方 `Input`（连同官方图标与焦点样式）。

GC 是唯一会**停止所有运行中 agent** 的动作：确认后进入不可关闭的等待弹窗，避免用户在 VACUUM 期间
做别的操作。

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

## 文档

- 决策：[ADR-禁用上游已归档入口改由对话管理页承载](../better-session/.agents/adrs/20260918-禁用上游已归档入口改由对话管理页承载.md)
- 测试落点：[`src/__tests__/`](./src/__tests__)（注册面 / 页面 / 注入面三条 spec）
