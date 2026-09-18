# css-in-js 样式层与官方 token 消费

状态：已采纳

fork 过来的对话 UI（`packages/session/ui-conversation`）沿用上游的 CSS Modules：
`.module.css` 需要 lightningcss 在构建期编译并内联成 `<style>` 注入代码。这带来两件事——样式必须经过
一次预编译才能加载，以及样式与组件分居两处。目标是样式统一走 css-in-js，让前后端不经过任何预编译
即可加载同一份源码。

设计变量则不必自己造：官方 `ui-theme` 已经把 `--dsw-*` 注入 `body`（light）与
`body[data-ds-dark-theme]`（dark），我们**只消费**。

## 决策

建立 `@morlay/dsh-client-ui-primitives`（`packages/client/ui-primitives`），提供 css-in-js 样式层：

- `styled('div')(...styles)`：样式对象 → 哈希 id + `data-css-*` 属性；
- `styling`：规则表与**惰性立即注入**（新规则首次生成即 append `<style data-css>`，按 id 去重）；
- `Token`：变量引用代理（`vars`）、局部变量赋值（`assignVars`）、变体选择器（`variants`）与组合子
  （`calc` / `min` / `max` / `url` / `colorMix` / `colorScale` / `fallbackVar` / `val`）；
- `dsw`：官方主题变量引用，`dsw.alias.bg.base` → `var(--dsw-alias-bg-base)`；
- `designTokens`：由上游 CSS **生成**的 token 树，叶子是该变量的默认值。

token 树由`packages/client/ui-primitives/scripts/gen-design-tokens.mts` 从上游主题源码
生成（359 个 `--dsw-*`），`pnpm --filter @morlay/dsh-client-ui-primitives run gen:tokens`
重新生成；`design-tokens.spec.ts` 守卫漂移（树与上游定义集合逐一相等）、往返（叶子能
还原变量名）与默认值完整性。

## 考虑过的选项

| 选项                                                     | 代价                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 继续用上游 CSS Modules                                   | 需要预编译；样式与组件分离；与「源码直接加载」的目标相悖                                          |
| 手写一份常用 token 清单                                  | 359 个变量里跟不住上游增删，漂移无人守                                                            |
| 移植参考实现的原样（`@tspkg/runtime` + `@ark-ui/react`） | 多两个运行时依赖；其 `signal`/`produce`/`effect` 只为 Provider 响应式服务，`ark` 只为 polymorphic |
| **生成 token 树 + 轻量 styled（选定）**                  | 每次上游主题变化重跑生成器；换来类型化访问与零预编译                                              |

## 后果

- 与上游 `@deepseek-ai/dsh-client-ui-primitives` **平行**：那个是平台 baseline 模块（前端种子静态提供），
  插件无法替换；本包不替换它、也不依赖它，只服务本仓库的 fork 包。
- 不提供 Provider：我们的组件由上游 `ChatView` 渲染，没有自己的渲染根；注入因此做成惰性立即注入。
- `styled` 不做 polymorphic（无 `as` / `asChild`）：需要换元素时 `styled('a')` 或包一层组件。
- 值只在生成物里（默认值），运行时不重新定义官方变量——主题切换仍由官方 `--dsw-*` 覆盖完成。
- 后续：fork 包逐个把 CSS Modules 换成 `styled` + `dsw`。
