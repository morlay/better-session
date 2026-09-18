# @morlay/dsh-desktopify

把任意 dsh 工作区打包 / 运行为桌面应用的工具：`dev` 链接工作区直接跑，`bundle` 产出静态、无签名的应用目录。

实现机制（壳与 host 协议、依赖闭包与种子指纹、桌面 preset 物化、XDG 路径与 shell 注入）见
[设计 桌面化工具](./.agents/designs/20260917-桌面化工具.md)；自研离线打包器（而非直接用上游桌面应用）的决策见
[ADR-20260917-自研离线桌面打包器而非直接用上游桌面应用](../../../.agents/adrs/20260917-自研离线桌面打包器而非直接用上游桌面应用.md)。

## 命令

| 命令                                                    | 作用                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `dsh-desktopify dev [--web] [workspace]`                | 启动 Electron 壳（不打包）；`--web` 改为在浏览器里跑 `dsh web` |
| `dsh-desktopify bundle [--dir] [--install] [workspace]` | 构建当前平台的静态、无签名桌面应用                             |

工作区取首个位置参数（缺省当前目录），CLI 会把它写进 `DSH_DESKTOP_WORKSPACE`；工具内不写死任何 app 路径或名字。
壳产物由 `pnpm build` 生成，dev / bundle 只校验它在，不重建——源码形态下产物比源码旧会打印警告（改了壳没重建的话，
打包出来的 app 跑的还是旧壳）。随包 Node.js 运行时的下载校验与 profile 种子生成是 `bundle` 的内部步骤，
不单独暴露命令。本仓库示例工作区：`just custom desktop`（dev）/ `just custom bundle`（打包）。

## 工作区契约（package.json）

```jsonc
{
  "name": "dsh-custom",
  "version": "0.1.5", // 应用版本（electron-builder product version）
  "private": true,
  "dependencies": { "@morlay/better-session": "^0.0.17" },
  "dsh": {
    "version": "0.1.5-rc.1", // @deepseek-ai/dsh 的依赖 spec：具体版本或 workspace:
    "profile": { "bundles": ["@morlay/better-session"] },
    "desktop": {
      "id": "ai.deepseek.dsh.custom",
      "icon": "icon.svg",
      "dshHome": "xdg",
      // 可选：包自己用 dsh.configTrees 声明时不用写
      "agentPresets": ["@morlay/dsh-preset/dist/presets"],
    },
  },
}
```

`dsh.version` 是 `@deepseek-ai/dsh` 的依赖 spec：仓库内项目可配 `workspace:^`（从 vendor 源码解析），
仓库外项目配具体版本（从 registry 安装）；缺省时回退到工作区已解析的 dsh 版本。配 `workspace:` 时工具不把它落成
版本号（本地源码可能尚未发布），而是指向解析到的包目录。打包时工作区没有的官方包（实验包这类）按这个版本钉住
装进部署项目；`workspace:` 与缺省 dsh.version 都不行时，只能靠工作区自己装齐官方包。

## 环境变量

| 变量                              | 作用                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DSH_DESKTOP_WORKSPACE`           | 目标工作区（位置参数会写入）                                                                                                                        |
| `DSH_DESKTOP_NODE_BINARY`         | dev / 打包后 host 使用的 node 可执行文件                                                                                                            |
| `DSH_DESKTOP_APPCONFIG_DIR`       | 覆盖 `appconfig.json` 所在目录（dev / 测试）                                                                                                        |
| `DSH_DESKTOP_SEED_DIR`            | 覆盖 profile 种子目录（dev / 测试）                                                                                                                 |
| `DSH_DESKTOP_DEV_PROJECT_DIR`     | 覆盖 dev 临时项目目录                                                                                                                               |
| `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` | 覆盖 host argv[4] 的载荷源目录（见[债务 20260918-桌面未随包primary-runtime载荷](../../../.agents/debts/20260918-桌面未随包primary-runtime载荷.md)） |
| `DSH_DESKTOP_TSX_IMPORT`          | dev 启动器写入的 tsx loader spec（无 tsx 时为空）                                                                                                   |
| `DSH_DESKTOP_OPEN_DEVTOOLS`       | dev 是否自动打开 DevTools（默认 `1`，置 `0` 关闭）                                                                                                  |
| `DSH_DESKTOP_HOST_INSPECT_PORT`   | host 调试端口（默认 9230）                                                                                                                          |
| `DSH_DESKTOP_MAIN_INSPECT_PORT`   | 主进程调试端口（默认 9229）                                                                                                                         |
| `DSH_DESKTOP_RENDERER_DEBUG_PORT` | 渲染进程调试端口（默认 9222）                                                                                                                       |
| `DSH_DESKTOP_TARGET_PLATFORM`     | bundle 随包 Node 的目标平台（默认当前平台）                                                                                                         |
| `DSH_DESKTOP_TARGET_ARCH`         | bundle 随包 Node 的目标架构（默认当前架构）                                                                                                         |
| `DSH_DESKTOP_DIAGNOSTIC_FILE`     | 壳启动失败时把错误栈写入该文件                                                                                                                      |
| `DSH_APP_DSH_HOME`                | 覆盖运行时 `DSH_HOME`（优先于 `dshHome` 配置）                                                                                                      |

## 前置条件

- pnpm workspace（dev 依赖 `findWorkspaceRoot` 装配临时项目；bundle 依赖 `pnpm deploy` 导出 app 闭包，
  工具不改写工作区清单 / lockfile）。
- `vendor/deepseek-harness` 已构建（`just vendor prepare`：dev 需要 dsh CLI，工具构建需要 desktop-host 的
  `lib/` 产物来打进 `dist/desktop-host`）。
- 工具自身已构建（`pnpm build`）：dev / bundle 用 `dist/desktop-host` 里的后端产物。
- 前端静态资源来自闭包内 `@deepseek-ai/dsh-web-frontend/dist`（`dsh` → `dsh-web-app` 的传递依赖），
  壳按 `<runtimeDir>/node_modules/@deepseek-ai/dsh-web-frontend/dist` 读取。

## 已知行为

- **启动即静默退出**（残留 `SingletonLock`，无输出、退出码 0）：清掉 `<userData>/Singleton*` 即可恢复；
  机制见 [设计 桌面化工具](./.agents/designs/20260917-桌面化工具.md)。
