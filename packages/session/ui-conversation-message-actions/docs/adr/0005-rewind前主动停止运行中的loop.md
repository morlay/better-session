# 0005-rewind 前主动停止运行中的 loop

每次 rewind——edit / retry / reroll、recall、HTTP `rewind` 三处编排入口，以及
覆盖导入（`session.import` 对已存在会话的 `rewind(-1)`）——都在截断前先停止
驻留 agent 运行中的 loop：`agent.cancel({ kind: "user" }, { keepInbox: true })`
后 `await agent.whenIdle()`。rewind 直接重写 agent 的 session 内存 log
（`truncateLiveSession`），与运行中的 loop 并发会写穿截断边界。

## 考虑过的选项

- **只等待（`whenIdle`）不主动停止**：长回合（工具调用、长回复）下用户点编辑 /
  撤回会一直挂起，要等回合自己跑完——操作不可控。
- **不等待也不停止（直接 rewind）**：live agent 正在写内存 log 时截断，写穿边界；
  公共 `rewind` 此前正是这种形态。
- **`keepInbox: false`（停止即丢弃排队输入）**：停止发生在 rewind 之前，而 rewind
  可能因边界校验失败整体拒绝（操作原子性）；此时不应已经丢弃排队输入。
  `keepInbox: true` 把丢弃留给 rewind 之后的既有 durable 取消路径。
- **要求 agents 面必须提供 `cancel`**：duck-typed 契约下实现可能没有该能力
  （测试替身、纯持久化环境）；`cancel?` 缺省时退化为等待其自然停下。

## 后果

- `EditorAgent` 增加可选 `cancel(cause, options)`；私有 `stopLoop` 成为三处
  rewind 入口（`branchOperation` / `recallOperation` / 公共 `rewind`）的统一前置。
- `session-rdb` 的覆盖导入（`persistImport`）增加可选 `stopLoop` 端口，HTTP
  入口注入与编排层同语义的 `stopAgentLoop`（duck-typed `agents`）；rdb 的
  `rewind` 原语保持纯截断，前置条件记在
  [branch.md](../../../session-rdb/docs/branch.md)。
- 被停止的那一轮以 `aborted`（reason `user`）收尾；其后的内容在 edit / retry
  语义下由重放接管，recall 语义下交给用户修改后重新发送。
- 完整语义见 [README「agent 驱动」](../../README.md)。
