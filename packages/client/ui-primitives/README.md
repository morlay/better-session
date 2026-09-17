# @morlay/dsh-client-ui-primitives

对话 UI 的 **css-in-js 样式层**：`styled` / `Token` / `Styling`，消费官方主题已注入的
`--dsw-*` 变量，因此不需要 CSS Modules 那一步预编译（源码可直接加载）。

设计取舍（为什么 css-in-js、为什么生成 token 树）见 [ADR-0001](./.agents/adrs/0001-css-in-js样式层与官方token消费.md)。

## 能力

| 导出                      | 用途                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `styled('div')(style, …)` | 生成带 `data-css-*` 的组件；多个样式对象深合并（变体叠基样式）                                                                                                               |
| `styling`                 | `props(style)` 取 `data-css-*` 属性、`keyframes`、`injectGlobals`、`sheets()`                                                                                                |
| `Token`                   | 变量引用代理（`vars`）、局部变量赋值（`assignVars`）、变体选择器（`variants`）、组合子（`calc` / `min` / `max` / `url` / `colorMix` / `colorScale` / `fallbackVar` / `val`） |
| `dsw`                     | 官方主题变量引用：`dsw.alias.bg.base` → `var(--dsw-alias-bg-base)`                                                                                                           |
| `designTokens`            | 生成的 token 树，叶子是官方默认值（可作 fallback 与类型推导来源）                                                                                                            |

样式注入是**惰性立即注入**：某条规则第一次生成时就 append `<style data-css="…">`（按 id 去重）。
不提供 Provider——我们的组件由上游 `ChatView` 渲染，没有自己的渲染根可挂 Provider。

## 与上游 `ui-primitives` 的关系

上游 `@deepseek-ai/dsh-client-ui-primitives` 是平台 baseline 模块（前端种子静态提供），插件无法替换，
它导出的是 CSS Modules 版本的组件。本包与它平行，只服务本仓库的 fork 包：不替换 baseline，也不依赖它。

## token 树

`src/client/theme.generated.ts` 由 `scripts/gen-design-tokens.mts` 从
`vendor/deepseek-harness/packages/client/ui-theme/src` 生成（357 个 `--dsw-*`）：

- 叶子 = 该变量的默认值（light 主题里首次出现的定义）；
- `"$"` 键 = 「自身也是 token 的分支」（命名体系里有 40 个短名同时是长名前缀，如 `alias-border-l2`）；
- 重新生成：`pnpm --filter @morlay/dsh-client-ui-primitives run gen:tokens`。

`src/__tests__/design-tokens.spec.ts` 守卫三件事：树与上游定义集合**逐一相等**（漂移即失败）、
每个叶子都能还原出变量名（往返无损）、每个叶子都带默认值。

## 装配

作为 profile 的一行装入（client 半按 `dsh.client` 声明加载）：

```yaml
- insert:
    - id: ui-primitives-fork
      name: "@morlay/dsh-client-ui-primitives"
```

## 已知限制

- token 值只在生成物里（默认值），运行时不重新定义官方变量；主题切换仍由官方 `--dsw-*` 覆盖完成。
- `styled` 不做 polymorphic（无 `as` / `asChild`）：需要换渲染元素时直接 `styled('a')` 或包一层组件。
