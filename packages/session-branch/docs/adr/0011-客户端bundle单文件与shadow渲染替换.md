# 0011-客户端 bundle 单文件与 shadow 渲染替换

浏览器半（client bundle）经 `__ModuleLoader__.load` 手递，**替换整个
`conversation.chat.node`**：12 个 key（user / steering / context /
assistant-step / command / manual-compaction / compaction / model-retry /
turn-error / turn-max-tokens / turn-tail / unknown）全部以 `priority: -1`
重新注册（最低优先级渲染，shadow 上游渲染器），编辑 / 重试按钮只挂在
user 消息上。构建约束：client bundle 必须是**单文件**（client-modules 只
服务/加载 `client.js`）——`noExternal` 全内联第三方 +
`inlineDynamicImports` 合并动态 import，`@deepseek-ai/*` 一律 external
（平台 seed 词或独立插件，内联会把别的插件的 `__ModuleLoader__.load` 嵌
进来导致 duplicate factory）。

## 考虑过的选项

- **只替换单个节点渲染器**（如仅 user 消息）：上游渲染器仍会渲染
  assistant 消息，无法统一控制操作后刷新与重试入口的显示条件。
- **多文件 bundle**：client-modules 只服务/加载 `client.js`，多文件需要
  修改上游加载机制（违反红线）。

## 后果

- 操作后刷新优先调用客户端会话级 `resync()`（重置窗口并重新拉取历史，
  不整页重载）——rewind 的删除无法经 append-only 事件流表达，seq 回退只
  做增量会残留旧节点；不可用时回退 `location.reload()`。
- CSS Modules 经 lightningcss 内联 + `<style data-plugin>` 注入。
