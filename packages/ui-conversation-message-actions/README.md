# @morlay/ui-conversation-message-actions

`rewind / retry / recall / fork` 的**编排层**：在 `@morlay/session-branch` 的 provider
抽象之上组装完整功能（产品语义对齐 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)），
并提供**浏览器半**（client bundle）：替换 `conversation.chat.node` 的
`user` / `steering` 渲染，在 user 消息行内直接挂编辑 / 重试入口。

## 服务面（`ctx.sessionEditor`）

| 操作       | 语义                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| `edit`     | 编辑已落定文本块（用户消息 / 助手块），**就地**（rewind + 重写，session id 不变） |
| `reroll`   | 重生成最后一条已落定助手回复（使用原用户输入）                                    |
| `retry`    | 重试任意历史回合（`truncate` 只重放目标输入 / `preserve` 重放后续全部）           |
| `rewind`   | 截断式回退：原会话回退到闭合 `turn/end` 边界                                      |
| `recall`   | 撤回 user 消息到输入框：只 `rewind` 截断，不重写、不重放（交给用户改后重发）       |
| `fork`     | 从任意闭合边界派生**新会话**（唯一产生新 id 的操作）                              |
| `timeline` | 版本树投影（HTTP：`GET /session-editor?sessionId=…`）                             |

## 就地编辑语义

- **edit / retry / reroll 是就地操作**：`rewind` 截断到目标轮之前的闭合
  `turn/end` 边界，再 `append` 版本效果 + 手工回合 / 重放输入回**同一会话**
  ——session id 不变，版本树保持单根；
- **重放复用目标轮号**：轮首 user 编辑（含未闭合轮）整轮截断，重放接回原
  轮号；编辑 assistant 写入 manualTurn 后同步 agent 的轮次游标；
- **空轮吸收**：目标轮之前的空轮（`turn/start` 后直接 `turn/end`，早期重放
  缺陷的遗留形状）随截断一并删除，重放按保留前缀续号——轮次导航不再出现
  点不开的空项与轮号空洞；manualTurn 的轮号同样按保留前缀收敛（正常会话
  等于目标轮号）。版本效果仍记录**原**目标轮号（操作历史）；
- **只有 `fork` 创建新 id**（`ForkOperation` / `forkFrom`，纯 append 派生）；
- **`recall` 只截断不重写**：边界与 `edit` 的轮首 user 一致（轮首整轮截断到前一轮
  `turn/end`，轮内 followup exclusive drop），但只 `rewind` 即返回——不写版本效果、
  不重放；被撤回的 user 文本由浏览器半回填到 composer，用户修改后自行发送；
- 版本效果事件（`session-branch/version`）携带 `ignorable: true`：**原样落库**
  （rdb 不按信封过滤，与 JSONL 一致），非 branch 读者凭信封跳过；
- 重放输入经 agent 驱动（见下）排队到原会话，agent 基于截断后历史回复。

## agent 驱动（重放排队输入）

`agents` 服务以 duck-typed 接口使用（不硬依赖 `@deepseek-ai/dsh-agent`），
缺失时退化为「已 durable 的就地版本」（可随时 resume 续跑）：

- **live agent**（会话驻留 / 已恢复）：直接 `followup` 排队，不重建、不换 id；
  编辑前只等 agent 停下（`whenIdle`），残留排队输入由 rewind 在截断后强制
  durable 取消（session-rdb 的 live 会话钩子 `inbox.clear`）；
- **cold 会话**：`resume` 已持久化会话（`create` 对已持久化日志必失败），
  resume 后 agent 驻留（不 dispose，避免 session 被移出 store 破坏客户端窗口）；
- 模型 provider/model 在 **rewind 之前**从 `request/header` 解析（就地编辑
  可能截断掉 header，编辑第一轮 boundary = -1 时尤甚）。

## 浏览器半（client bundle）

`dist/client.js` 经 `__ModuleLoader__.load` 手递，替换 `conversation.chat.node`
的 `user` / `steering` 渲染：

- **shadow 注册**：`user` / `steering` 两个 key 以 `priority: -1` 重新注册
  （最低优先级渲染，shadow 上游默认注册）；其余 key 沿用上游渲染器；
- **编辑 / 重试按钮只挂在 user 消息**（`UserMessageNodeView`）：编辑不再打开编辑
  弹窗，而是确认（`Modal` + `Button`）后调用 `recall`——服务端只 `rewind` 截断，
  客户端把消息文本 `setDraft` 回填到主输入框（`conversation.input`），交给用户
  修改后自行发送；重试仍先弹确认；未闭合轮次不显示重试；
- **操作后刷新**：就地编辑后优先调用客户端会话级 `resync()`（重置窗口并重新
  拉取历史，不整页重载——rewind 的删除无法经 append-only 事件流表达，seq
  回退只做增量会残留旧节点），随后丢弃该会话的全部投影行
  （`projections.truncate(-1)`）——投影 store 按 higher-seq-wins 保留 rewind
  前的高 seq 旧值，截断后的正确值 seq 更小，永远覆盖不上（轮次导航残留已
  删除的轮次）；不可用时回退 `location.reload()`；
- **构建约束**：client bundle 必须是**单文件**（client-modules 只服务/加载
  `client.js`）——`deps.neverBundle` 保持 react 与 `@deepseek-ai/*` external
  （平台 seed 词或独立插件，内联会把别的插件的 `__ModuleLoader__.load` 嵌进来
  导致 duplicate factory），其余依赖全部内联，`inlineDynamicImports` 合并动态
  import；CSS Modules 经 lightningcss 内联 + `<style data-plugin>` 注入。

## 分层边界

- 数据层（`forkFrom` / `rewind` / `readBranchPrefix`）来自
  `ctx.sessionBranch`（provider 实现，如 `@morlay/session-rdb`）；
- 本服务只做**编排**：闭合轮次扫描、版本效果事件构造、派生 seed 组装、
  rewind 命令透传、agent 驱动、HTTP 面（`POST /session-editor` 执行
  edit / reroll / retry / rewind / recall / fork）。

## 装配

```yaml
# cordis.patch.yml
- insert:
    - id: ui-conversation-message-actions
      name: "@morlay/ui-conversation-message-actions"
```

依赖 `ctx.sessionBranch` / `ctx.sessionPersistence`（需先装配
`@morlay/session-rdb` 等 provider 实现）与 `ctx.sessions`；`agents` 可选。

端到端装配真实 rdb 后端，验证 retry / rewind / fork / timeline 闭环，
以及 live 会话的 rewind（内存 log 截断 / handle cursor 对齐）与 agent 重放。
