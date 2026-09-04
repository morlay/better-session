# 0012-重放经 agent 驱动而非直接 append 回复

edit / retry / reroll 的重放输入经 `agents` 服务驱动（duck-typed 接口，
不硬依赖 `@deepseek-ai/dsh-agent`）：live agent 直接 `followup` 排队（不
重建、不换 id）；cold 会话先 `resume` 已持久化会话（`create` 对已持久化
日志必失败），resume 后 agent 驻留（不 dispose，避免 session 被移出 store
破坏客户端窗口）。模型 provider/model 在 **rewind 之前**从 `request/header`
解析（就地编辑可能截断掉 header，编辑第一轮 boundary = -1 时尤甚）。

## 考虑过的选项

- **直接 append 手工构造的 assistant 回复**：回复内容由代码构造而非模型
  生成，无法真正「重新生成」；且绕过 agent 的轮次状态机。
- **硬依赖 `@deepseek-ai/dsh-agent`**：上游包不可修改，且 agents 服务在
  纯持久化环境（无 agent-loop）中不存在。

## 后果

- agents 服务缺失时退化为「已 durable 的就地版本」（可随时 resume 续跑）
  ——重放是可选增强，不是正确性前提。
- agent resume 失败不应使已 durable 的版本失效：组合失败仅告警，版本
  保持可用。
