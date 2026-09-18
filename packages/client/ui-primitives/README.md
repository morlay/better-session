# @morlay/dsh-client-ui-primitives

对话 UI 的 **css-in-js 样式层**：`styled` / `Token` / `Styling`，消费官方主题已注入的
`--dsw-*` 变量，因此不需要 CSS Modules 那一步预编译（源码可直接加载）。

设计取舍（为什么 css-in-js、为什么生成 token 树、与上游 `ui-primitives` 的关系）见
[ADR-css-in-js样式层与官方token消费](./.agents/adrs/20260917-css-in-js样式层与官方token消费.md)。

## 能力

| 导出                      | 用途                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styled('div')(style, …)` | 生成带 `data-css-*` 的组件；多个样式对象深合并（变体叠基样式）                                                                                                               |
| `styling`                 | `props(style)` 取 `data-css-*` 属性、`keyframes`、`injectGlobals`、`sheets()`                                                                                                |
| `Token`                   | 变量引用代理（`vars`）、局部变量赋值（`assignVars`）、变体选择器（`variants`）、组合子（`calc` / `min` / `max` / `url` / `colorMix` / `colorScale` / `fallbackVar` / `val`） |
| `dsw`                     | 官方主题变量引用：`dsw.alias.bg.base` → `var(--dsw-alias-bg-base)`                                                                                                           |
| `designTokens`            | 生成的 token 树，叶子是官方默认值（可作 fallback 与类型推导来源）                                                                                                            |

样式注入是**惰性立即注入**（某条规则第一次生成时就 append `<style data-css="…">`，
按 id 去重），不提供 Provider。

## token 树

`designTokens`（`src/client/theme.generated.ts`）由 `scripts/gen-design-tokens.mts` 从
上游主题源码生成，共 **359 个 `--dsw-*`**：叶子是该变量在 light 主题里的默认值。
生成机制、`"$"` 键语义与守卫判据见
[ADR-css-in-js样式层与官方token消费](./.agents/adrs/20260917-css-in-js样式层与官方token消费.md)。

## 装配

本包是 profile 的一行 insert（client 半按 `dsh.client` 声明加载）；本仓库的装配真源是
`packages/session/better-session/cordis.patch.yml` 的 `ui-primitives-fork` 行。

## 已知限制

- token 值只在生成物里（默认值），运行时不重新定义官方变量；主题切换仍由官方 `--dsw-*` 覆盖完成。
- `styled` 不做 polymorphic（无 `as` / `asChild`）：需要换渲染元素时直接 `styled('a')` 或包一层组件。
