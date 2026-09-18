# @morlay/dsh-desktop-host

桌面部署里那个 **host 进程**：把 Web 应用按 `desktop` profile 启起来，并把 URL / index injections 通过 IPC
报给 Electron 壳。

上游 `apps/desktop-host`（`@deepseek-ai/dsh-desktop-host`）是 `private: true` 的应用，外部装不到，所以这里
是它的**变体包**：argv / IPC 契约、`lib/index.js` 入口路径照旧，差别只有一处——Office 组合不再挂
`@deepseek-ai/dsh-skill-office`（见 [`src/office.ts`](./src/office.ts)）。

## 用法

被 [`@morlay/dsh-desktopify`](../dsh-desktopify/README.md) 使用，不单独跑：

- `dev` / `bundle` 把本包整份（`lib/index.js` 及 manifest）复制进部署的
  `<runtime>/node_modules/@morlay/dsh-desktop-host`；
- 壳按 `<runtime>/node_modules/@morlay/dsh-desktop-host/lib/index.js` 启动它，argv 为
  `[runtimeDir, projectDir, primaryRuntime, profileResolution, pnpmEntry, nodeBin]`。

## 依赖边界

`@deepseek-ai/*` 全部由**部署自己的** `node_modules` 提供（与上游同边界）：

- `dependencies`：本包入口真正 import 的 `@deepseek-ai/dsh`（含 `./profile-boot` 子路径）、
  `@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-home-paths`；
- `peerDependencies`：`@deepseek-ai/cordis`；
- 类型面 `@deepseek-ai/dsh-client-connection` / `@deepseek-ai/dsh-host-webserver` 只在 devDependencies
  （空 import 带 Context merge，构建后即被擦除）；
- vendor 里的 `update-tasks` 与 `workspace-dependencies` 模块在构建期内联，运行期不依赖 vendor 路径。

清单只声明**这份代码真正用到**的包：上游那份 app manifest 里的组合依赖
（`@deepseek-ai/dsh-skill-office`、`dsh-agent`、`dsh-jobs`、`dsh-tools` …）属于部署的官方闭包，
由 `@morlay/dsh-desktopify` 的部署步骤按 profile 提供，不该由本包声明。
