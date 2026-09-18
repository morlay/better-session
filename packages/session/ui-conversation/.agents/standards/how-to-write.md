# 如何写（薄壳 fork 包）

`@morlay/dsh-client-ui-conversation` 是上游 `@deepseek-ai/dsh-client-ui-conversation` 的**薄壳 fork**：
只留我们有意改过的文件，其余靠相对 import 引上游源码，于是**上游 client 半源码进了同一个 TS program**。
下面几条是这件事的硬约束，改这个包或加同类包时都成立。

## 形态

- **只留有意改过的文件**（保留清单在[债务 20260917-临时接管上游对话UI的client半](../debts/20260917-临时接管上游对话UI的client半.md) 的「保留文件」表）；
  不再复制的上游文件由保留文件里**相对路径**的 import 指向
  `vendor/deepseek-harness/packages/client/ui-conversation/src/...`（上游文件内部的相对 import 不动，
  闭包在 vendor 内自解析）。
- 指向上游的那部分由 tsdown 构建期内联进 `dist/client.cjs`（发布物自包含）；开发态由
  `dev-client-bundles` 现场打包（上游组件的 `.module.css` 一并内联）。

## tsconfig

- **根 `tsconfig.json` 必须保持 `composite: false`**：composite 要求列全文件，而 vendor 源被 import 进来、
  又在 `exclude` 里 → `TS6307`。
- **不给这个包加包级 tsconfig**：dts 阶段按 tsconfig 推 `rootDir`，包级 tsconfig 会把 vendor 源推到
  `rootDir` 之外。

## 类型面

- **合并接口（`SlotMap` / `Context` / `Events` / `LocaleNamespaceMap`）只能有一份实例**：不在我们这边重复
  声明（结构相同也算不同实例 → `TS2717`）——`contract/slots.ts` 因此不保留，上游那份即唯一实例。
- **扩宽用「本地接口 extends 上游那份」**（`client/contract/input.ts` 的 `restoreDraft`）；确需断言时按
  运行期事实收窄一次并注明理由（`client/input/editor/view-binding.ts` 的 `clipboardUri`）。
