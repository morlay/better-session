# @morlay/ui-conversation-message-actions

`rewind / retry / fork` 的**编排层**：在 `@morlay/session-branch` 的 provider
抽象之上组装完整功能（产品语义对齐 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)），
并提供**浏览器半**（client bundle）：替换 `conversation.chat.node` 渲染，
在 user 消息行内直接挂编辑 / 重试入口。

## 服务面（`ctx.sessionEditor`）

| 操作       | 语义                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| `edit`     | 编辑已落定文本块（用户消息 / 助手块），**就地**（rewind + 重写，session id 不变） |
| `reroll`   | 重生成最后一条已落定助手回复（使用原用户输入）                                    |
| `retry`    | 重试任意历史回合（`truncate` 只重放目标输入 / `preserve` 重放后续全部）           |
| `rewind`   | 截断式回退：原会话回退到闭合 `turn/end` 边界                                      |
| `fork`     | 从任意闭合边界派生**新会话**（唯一产生新 id 的操作）                              |
| `timeline` | 版本树投影（HTTP：`GET /session-editor?sessionId=…`）                             |

## 就地编辑语义

- **edit / retry / reroll 是就地操作**：`rewind` 截断到目标轮之前的闭合
  `turn/end` 边界，再 `append` 版本效果 + 手工回合 / 重放输入回**同一会话**
  ——session id 不变，版本树保持单根；
- **只有 `fork` 创建新 id**（`ForkOperation` / `forkFrom`，纯 append 派生）；
- 版本效果事件（`session-branch/version`）携带 `ignorable: true`：live log 可见、
  **不落 canonical log**（rdb 持久化时过滤并稠密化剩余事件）；
- 重放输入经 agent 驱动（见下）排队到原会话，agent 基于截断后历史回复。

## agent 驱动（重放排队输入）

`agents` 服务以 duck-typed 接口使用（不硬依赖 `@deepseek-ai/dsh-agent`），
缺失时退化为「已 durable 的就地版本」（可随时 resume 续跑）：

- **live agent**（会话驻留 / 已恢复）：直接 `followup` 排队，不重建、不换 id；
- **cold 会话**：`resume` 已持久化会话（`create` 对已持久化日志必失败），
  resume 后 agent 驻留（不 dispose，避免 session 被移出 store 破坏客户端窗口）；
- 模型 provider/model 在 **rewind 之前**从 `request/header` 解析（就地编辑
  可能截断掉 header，编辑第一轮 boundary = -1 时尤甚）。

## 浏览器半（client bundle）

`lib/client.js` 经 `__ModuleLoader__.load` 手递，替换整个 `conversation.chat.node`：

- **shadow 注册**：12 个 key（user / steering / context / assistant-step /
  command / manual-compaction / compaction / model-retry / turn-error /
  turn-max-tokens / turn-tail / unknown）全部以 `priority: -1` 重新注册，
  最低优先级渲染，shadow 上游渲染器；
- **编辑 / 重试按钮只挂在 user 消息**（`UserMessageNodeView`）：编辑弹窗复用
  dsh settings 同款 `Modal` + `Button`，输入框复用 composer-card 视觉与自动
  增长；重试先弹确认；未闭合轮次不显示重试；
- **操作后刷新**：就地编辑后优先调用客户端会话级 `resync()`（重置窗口并重新
  拉取历史，不整页重载——rewind 的删除无法经 append-only 事件流表达，seq
  回退只做增量会残留旧节点），不可用时回退 `location.reload()`；
- **构建约束**：client bundle 必须是**单文件**（client-modules 只服务/加载
  `client.js`）——`noExternal` 全内联第三方 + `inlineDynamicImports` 合并
  动态 import，`@deepseek-ai/*` 一律 external（平台 seed 词或独立插件，
  内联会把别的插件的 `__ModuleLoader__.load` 嵌进来导致 duplicate factory）；
  CSS Modules 经 lightningcss 内联 + `<style data-plugin>` 注入。

## 分层边界

- 数据层（`forkFrom` / `rewind` / `readBranchPrefix` / `syncLiveCursor`）来自
  `ctx.sessionBranch`（provider 实现，如 `@morlay/session-rdb`）；
- 本服务只做**编排**：闭合轮次扫描、版本效果事件构造、派生 seed 组装、
  rewind 命令透传、agent 驱动、HTTP 面（`POST /session-editor` 执行
  edit / reroll / retry / rewind / fork）。

## 装配

```yaml
# cordis.patch.yml
- insert:
    - id: session-editor
      name: "@morlay/ui-conversation-message-actions"
```

依赖 `ctx.sessionBranch`（需先装配 `@morlay/session-rdb` 等
provider 实现）与 `ctx.sessions`（dsh-session）；`agents` 可选。

## 测试

```sh
just test packages/ui-conversation-message-actions
```

端到端装配真实 rdb 后端，验证 retry / rewind / fork / timeline 闭环，
以及 live 会话的 rewind（内存 log / coordinator cursor 同步）与 agent 重放。
