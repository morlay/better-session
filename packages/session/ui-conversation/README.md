# @morlay/dsh-client-ui-conversation

上游 `@deepseek-ai/dsh-client-ui-conversation` 的**薄壳 fork**（host 半 + client 半），一对一替换官方
`ui-conversation` 行：官方该行在装配里被禁用，槽声明、locale 与设置命名空间与我们保持同形；装配由
`@morlay/better-session` 的 bundle patch 完成。

**薄壳**：只保留我们**有意改过**的文件，其余上游文件不复制——保留文件里指向它们的 import 走相对路径指向
`vendor/deepseek-harness/packages/client/ui-conversation/src/...`，构建时由 tsdown 内联进 `dist/client.cjs`
（发布物自包含，`files: ["dist"]`），开发态由 `dsh-desktopify` 的 `dev-client-bundles` 现场打包（上游组件的
`.module.css` 一并内联）。

## 文档

- 接管的原因、保留文件清单、决策点与回退条件：
  [债务 20260917-临时接管上游对话UI的client半](./.agents/debts/20260917-临时接管上游对话UI的client半.md)
- 写法约束（根 `tsconfig.json` 保持 `composite: false`、合并接口只能一份实例）：
  [本包规范 how-to-write](./.agents/standards/how-to-write.md)
- 本包的接缝、测试落点与未覆盖：[本包规范 how-to-verify](./.agents/standards/how-to-verify.md)

同步上游时按债务里的「保留文件」表处理冲突，其余文件直接跟随上游。
