# @morlay/ui-conversation-message-actions

`rewind / retry / recall / fork` 的**编排层**：在 `@morlay/session-branch` 的 provider 抽象之上组装完整功能（产品语义
对齐 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)），并提供**浏览器半**（client bundle）：替换
`conversation.chat.node` 的 `user` / `steering` 渲染（在 user 消息行内直接挂编辑 / 重试入口），并覆盖
`conversation.composer.dock` 的 `stats` 行（composer 统计：修好的 token 口径 + `data-composer-stats`）。

## 用法

装配只需在 profile 的 `dsh.profile.bundles` 里列出本包——本包自带 bundle patch
（[`cordis.patch.yml`](./cordis.patch.yml)）插入插件行并注册 `ctx.sessionEditor`。依赖 `ctx.sessionBranch` /
`ctx.sessionPersistence`（需先装配 provider 实现，如 `@morlay/session-rdb`）与 `ctx.sessions`；`agents` 可选，缺失时
重放退化为「已 durable 的就地版本」。

```ts
// host：装配后直接调服务
await ctx.sessionEditor.retry({ action: "retry", sessionId, turn: 2, cascade: "truncate" });
const timeline = await ctx.sessionEditor.timeline({ sessionId });
```

HTTP 面：web 模式 `POST` / `GET /session-editor`；宿主内嵌客户端走 `connection.fetch` 的 `/api/session-editor`。

## 结论

edit / retry / reroll 就地重写**同一会话**（session id 不变、版本树单根），只有 `fork` 派生新 id；`recall` 只截断并把文本
交回 composer，由用户改后自己发
（[ADR 就地编辑重写同一会话而非新建会话](./.agents/adrs/20260917-就地编辑重写同一会话而非新建会话.md)）。

## 文档

- 操作语义全文（服务面 / 就地编辑 / agent 驱动 / 浏览器半 / 分层边界）：
  [设计 20260917-编排层操作语义](./.agents/designs/20260917-编排层操作语义.md)
- 决策：[`.agents/adrs/`](./.agents/adrs)（接管官方 `ui-conversation` 行、client bundle 单文件与 shadow 渲染、引用解析、
  编辑入口门控…）
- 接缝、测试落点与未覆盖：[本包规范 how-to-verify](./.agents/standards/how-to-verify.md)
- 整体设计：[设计 20260917-系统设计](../../../.agents/designs/20260917-系统设计.md)
