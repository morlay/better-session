# 客户端 bundle 单文件与 shadow 渲染替换

状态：已采纳

浏览器半（client bundle）经 `__ModuleLoader__.load` 手递，替换
`conversation.chat.node` 的 `user` / `steering` 渲染：两个 key 以
`priority: -1` 重新注册（最低优先级渲染，shadow 上游默认注册），编辑 / 重试
按钮只挂在 user 消息上；其余 key 沿用上游渲染器。同一 shadow 手段也用于 list 槽：
`conversation.composer.dock` 的 `stats` id 以 `priority: -1` 覆盖官方同 id 行
（承载修好的 token 口径与 `data-composer-stats`，见[债务 20260917-临时接管上游对话UI的client半](../../../ui-conversation/.agents/debts/20260917-临时接管上游对话UI的client半.md)）。构建约束：client bundle
必须是**单文件**（client-modules 只服务/加载 `client.js`，产物落
`dist/client.cjs`）——devkit 的 client 入口插件（`clientEntryPlugin` +
`isClientExternal`）保持平台 baseline（react / cordis / store / slots /
primitives）与 `@deepseek-ai/*` client 插件行 external（由模块表提供，内联会把
别的插件的 `__ModuleLoader__.load` 嵌进来导致 duplicate factory），契约层
（`dsh-session` / `dsh-llm` / `dsh-util-*` 等无模块表条目的包）与第三方依赖
全部内联。

## 考虑过的选项

- **替换全部聊天节点 key**：会与上游渲染器大面积 shadow、重复维护；
  实际只需 `user` / `steering`（编辑 / 重试入口所在），其余沿用上游。
- **多文件 bundle**：client-modules 只服务/加载 `client.js`，多文件需要
  修改上游加载机制（违反红线）。

## 后果

- 操作后刷新（`resync()` + 投影截断）与单文件约束的现状细节见
  [设计 编排层操作语义](../designs/20260917-编排层操作语义.md) 的「浏览器半」。
- CSS Modules 经 lightningcss 内联 + `<style data-plugin>` 注入。
