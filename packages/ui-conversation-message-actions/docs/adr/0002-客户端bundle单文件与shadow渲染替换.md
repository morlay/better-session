# 0002-客户端 bundle 单文件与 shadow 渲染替换

浏览器半（client bundle）经 `__ModuleLoader__.load` 手递，替换
`conversation.chat.node` 的 `user` / `steering` 渲染：两个 key 以
`priority: -1` 重新注册（最低优先级渲染，shadow 上游默认注册），编辑 / 重试
按钮只挂在 user 消息上；其余 key 沿用上游渲染器。构建约束：client bundle
必须是**单文件**（client-modules 只服务/加载 `client.js`）——
`deps.neverBundle` 保持 react 与 `@deepseek-ai/*` external（平台 seed 词或
独立插件，内联会把别的插件的 `__ModuleLoader__.load` 嵌进来导致 duplicate
factory），其余依赖内联 + `inlineDynamicImports` 合并动态 import。

## 考虑过的选项

- **替换全部聊天节点 key**：早期方案，会与上游渲染器大面积 shadow、重复
  维护；实际只需 `user` / `steering`（编辑 / 重试入口所在），其余沿用上游。
- **多文件 bundle**：client-modules 只服务/加载 `client.js`，多文件需要
  修改上游加载机制（违反红线）。

## 后果

- 操作后刷新（`resync()` + 投影截断）与单文件约束的现状细节见
  [README「浏览器半」](../../README.md)。
- CSS Modules 经 lightningcss 内联 + `<style data-plugin>` 注入。
