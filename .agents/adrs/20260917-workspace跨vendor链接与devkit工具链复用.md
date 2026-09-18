# workspace 跨 vendor 链接与 devkit 工具链复用

状态：已采纳

背景：本仓库与 vendor 上游构成**单一 pnpm workspace**（成员含
`vendor/deepseek-harness/packages/*/*` 等），且工具链集中在
`devpackages/devkit`。

**决定**

三个 workspace 配置**显式声明为 true**——固定语义，不依赖 pnpm 默认值随版本变化：

```yaml
linkWorkspacePackages: true
hoistWorkspacePackages: true
autoInstallPeers: true
```

- **`linkWorkspacePackages: true`**：workspace 内互引一律链接——保证
  `@deepseek-ai/*` 全仓库只有**一份上游源码**。否则 `workspace:*` 之外的上游
  依赖会从 registry 解析成**发布副本**，与源码副本并存 → 同名 branded
  类型 / 枚举出现两份，tsc 下互不兼容（类型唯一性破坏）。
- **`hoistWorkspacePackages` + `autoInstallPeers`**：peer 依赖（如
  `@deepseek-ai/cordis`）自动安装并提升到根——各插件包只需声明运行期
  import 的上游包为 `workspace:*` 的 peerDependencies，无需为每个上游包
  重复声明 devDeps。

工具链集中 `devpackages/devkit`（private workspace 包，TS 源码直出），
插件包不再各自维护重复的编译 / 构建配置：

- **tsconfig 复用**：根 `tsconfig.json` `extends` `devkit/tsconfig.json`
  ——编译选项单点声明（strict / noUncheckedIndexedAccess / nodenext 等），
  全仓库一致；新建包需要独立 face 配置时同样 extends 它。
- **tsdown 配置工厂** `defineCordisPluginConfig()`（devkit 导出）：
  收敛 cordis 插件包重复的公共构建选项（ESM、exports：packageJson /
  devExports / cordis.patch.yml 与 `./client` 透传、deps.onlyBundle、
  clean），entry 按约定探测（`src/index.ts` + 存在则 `src/invariant.ts`）。
  包级 `tsdown.config.ts` 从 ~20 行模板收敛为单入口声明：

  ```ts
  // host-only 包
  import { defineCordisPluginConfig } from "devkit";
  export default defineCordisPluginConfig();

  // host + client bundle 包（client 作为补充产物，exports 单声明）
  export default defineCordisPluginConfig({
    client: { name: "@morlay/ui-conversation-message-actions", entry: "src/client/index.ts" },
  });
  ```

  client 构建由 devkit 组装进同一次构建：`clientEntryPlugin` 用现场打包的单文件字节
  替掉 tsdown 的 client chunk（host/client 共享模块在分块模型下无法各留一份），
  `cssInlinePlugins` 补上样式解析——`.module.css` 交 lightningcss 编译出
  `[hash]_[local]` 的 class 映射并注入 `<style>`，其余 `.css` 只注入，`.css?inline`
  导出编译后的文本；`addWatchFile` 让样式文件进 watch 图。exports 只在 host 声明一次
  （含 `./client` customExport，否则 tsdown devExports 重写会清掉它），避免 tsdown
  多配置 exports 冲突。

- **样式内联自己实现，不复用 vendor 的同一份逻辑**：上游那三个插件内联在未导出的
  `clientConfig` 里（导出面只有 `clientBundle`），复用会拖进 `REPOSITORY_ROOT`、
  `packages/*/*` 清单扫描、`PLATFORM_MODULES` 等上游仓库内部路径。代价是语义有一份
  重复，由 devkit 自己的单测钉住（`devpackages/devkit/src/__tests__/css.spec.ts`，
  含「样式 import 不残留」「class 映射与上游同形」「watch 图登记」）；`resolveId` 用
  `order: 'pre'`，与上游 patch（`patches/css-inline-query.patch`）保持同一口径。

## 考虑过的选项

- **每个包独立 tsconfig + 独立 tsdown.config.ts 复制**：配置模板重复，
  升级编译选项 / 构建选项要逐包改，易漂移。
- **工具链放根 package.json devDeps 共享、不抽象**：tsdown 公共选项仍
  逐包复制，没有"生成"能力。

## 后果

- 编译 / 构建配置单点声明，升级工具链（tsdown / typescript）只改
  devkit 与根。
- 新插件包脚手架 = 一行 tsdown 配置（根 tsconfig 已 extends devkit），无
  模板复制。
- devkit 是 TS 源码直出（`exports: { ".": "./src/index.ts", "./tsconfig.json":
"./tsconfig.json" }`），由 tsdown / tsx 等 TS 加载器消费，无需自身构建链。
- 已知限制（样式内联只覆盖**代码**图，不覆盖 client 的**声明**图）：client 入口把
  `?inline` 的文本**再导出**时，tsdown 的 dts 这一步失败——生成的 `.d.ts` 保留
  `import x from "../x.css?inline"`，而声明图里没有样式解析。样式只在内部分使用
  （含组件内 `import css from "./X.module.css"`）不受影响。上游把 client 的 dts 关掉
  （类型走 `lib/types`）绕开了同类问题。
