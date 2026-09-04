# 0002-workspace 跨 vendor 链接与 devkit 工具链复用

本仓库与 vendor 上游构成**单一 pnpm workspace**（成员含
`vendor/deepseek-harness/packages/*/*` 等），且工具链集中在
`devpackages/devkit`。三个 workspace 配置必须为 true——它们不能沿用 pnpm
默认（`hoistWorkspacePackages` / `autoInstallPeers` 默认 false）：

```yaml
linkWorkspacePackages: true
hoistWorkspacePackages: true
autoInstallPeers: true
```

- **`linkWorkspacePackages: true`**：workspace 内互引一律链接——保证
  `@deepseek-ai/*` 全仓库只有**一份上游源码**。否则 `workspace:^` 之外的上游
  依赖会从 registry 解析成**发布副本**，与源码副本并存 → 同名 branded
  类型 / 枚举出现两份，tsc 下互不兼容（类型唯一性破坏）。
- **`hoistWorkspacePackages` + `autoInstallPeers`**：peer 依赖（如
  `@deepseek-ai/cordis`）自动安装并提升到根——各插件包只需声明运行期
  import 的上游包为 `workspace:^` 的 peerDependencies，无需为每个上游包
  重复声明 devDeps。

## devkit：tsconfig 与 tsdown 配置复用

工具链集中 `devpackages/devkit`（private workspace 包，TS 源码直出），
插件包不再各自维护重复的编译 / 构建配置：

- **tsconfig 复用**：根 `tsconfig.json` 与各包统一 `extends`
  `devkit/tsconfig.json`——编译选项单点声明（strict /
  noUncheckedIndexedAccess / nodenext 等），全仓库一致。
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

  client 构建（`defineCordisClientConfig`：ModuleLoader 手递、react 与
  `@deepseek-ai/*` external、CSS Modules 内联）由 devkit 内部组装进返回
  数组——exports 只在 host 声明一次（含 `./client` customExport，否则
  tsdown devExports 重写会清掉它），避免 tsdown 多配置 exports 冲突。

## 考虑过的选项

- **每个包独立 tsconfig + 独立 tsdown.config.ts 复制**：早期形态，配置
  模板重复；升级编译选项 / 构建选项要逐包改，易漂移。
- **工具链放根 package.json devDeps 共享、不抽象**：tsdown 公共选项仍
  逐包复制，没有"生成"能力。

## 后果

- 编译 / 构建配置单点声明，升级工具链（tsdown / typescript）只改
  devkit 与根。
- 新插件包脚手架 = 一行 tsdown 配置 + extends devkit tsconfig，无模板
  复制。
- devkit 是 TS 源码直出（`exports: { ".": "./src/tsdown.ts" }`），由
  tsdown / tsx 等 TS 加载器消费，无需自身构建链。
