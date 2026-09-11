# @morlay/dsh-desktopify

把任意 dsh 工作区打包 / 运行为桌面应用的工具：`dev` 链接工作区直接跑，
`bundle` 产出静态、无签名的应用目录。实现参考上游官方 `apps/desktop`
（Electron 壳）+ `apps/desktop-host`（字节管道后端），迁移决策见
[ADR 0003](../../docs/adr/0003-桌面化从golang壳迁移到Electron与上游desktop-host.md)。

## 命令

| 命令                                                    | 作用                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `dsh-desktopify dev [--web] [--skip-build] [workspace]` | 启动 Electron 壳（不打包）；`--web` 改为在浏览器里跑 `dsh web` |
| `dsh-desktopify bundle [--dir] [--install] [workspace]` | 构建当前平台的静态、无签名桌面应用                             |
| `dsh-desktopify build`                                  | 壳产物检查（源码形态的壳构建由 `pnpm build` 负责）             |
| `dsh-desktopify prepare:runtime [workspace]`            | 下载并校验随包 Node.js 运行时                                  |
| `dsh-desktopify prepare:seed [workspace]`               | 生成打包用 profile 种子                                        |

工作区取首个位置参数（缺省当前目录），CLI 会把它写进
`DSH_DESKTOP_WORKSPACE`；工具内不写死任何 app 路径或名字。壳产物由
`pnpm build` 生成，dev / bundle 不重建（`--skip-build` 因此无实际作用）。
本仓库示例工作区：`just custom desktop`（dev）/ `just custom bundle`（打包）。

## 结构

- **工具形态**：源码与 CLI 全 TS。开发形态 `bin` 直指 `src/cli/index.ts`
  （Node 原生类型剥离直接执行）；`exports` / `bin` / `main` 由
  `tsdown.config.ts` 的 `exports` 选项在构建期收敛进 package.json——开发
  形态指 `src/*.ts`，发布形态经 `publishConfig` 指 `dist/*`，对外只有 bin
  一个入口。
- **壳**：Electron 主进程（`dsh-app://` 自定义协议 + host 子进程守护），
  复用上游 `host-process.ts` / `host-protocol.ts`（纯 node 实现，协议版本
  3）；无标题栏窗口（macOS 隐藏标题栏保留交通灯，Windows 经 `titleBarOverlay`
  保留系统窗口控制按钮，其余平台无边框），退出（红叉 / Cmd+Q / 菜单）先经
  确认框，确认后才停止后端并退出。产物 `dist/index.mjs` +
  `dist/preload*.cjs`（sandboxed preload 必须是 CJS）。
- **打包**：electron-builder 经 Node API 在
  `src/cli/electron-builder.ts` 内配置（无独立配置文件）。壳以最小 app
  目录（`dist/` + 入口 manifest，版本取工作区版本）打包，工具自身的构建
  依赖不进 app；`--dir` 产出未打包的应用目录，不签名、不 notarize。
- **后端**：复用上游已构建的 desktop-host 产物（字节管道协议），不重复实现
  boot 逻辑。上游 `@deepseek-ai/dsh-desktop-host` 是 `private` 包、不发布，
  所以 `tsdown.config.ts` 构建时把它的 `lib/index.js` +
  `config/desktop.cordis.patch.yml` + manifest `copy` 进 `dist/desktop-host`，
  运行时从这里装配；`package.json` 不再依赖该私有包，可正常发布。
- **官方依赖内部维护**：`@deepseek-ai/*` 依赖清单（dsh、dsh-desktop-host、
  cordis-plugin-group 及约 20 个 peer 包）由工具内部维护
  （`src/official.ts`），app 只声明自己的依赖、`dsh.version` 与 bundles。
  官方依赖 spec 由工具按 `dsh.version` + 已安装包解析
  （`src/cli/official-deps.ts`）：app 工作区优先，工具自身安装兜底，不写死
  `workspace:`，仓库外的独立项目同样可装配；desktop-host 用工具自带的产物
  （同一 workspace 用 `link:`，独立项目暂存后 `file:`）。
- **bundles 自动合并**：官方 bundles（`@deepseek-ai/dsh-base`、
  `@deepseek-ai/dsh-web-app`）+ app 的 `dsh.profile.bundles` 自动合并进 dev
  项目与种子 profile。
- **桌面 preset 物化**：桌面宿主把 `agent-presets.roots` 固定为 dsh 包内的
  `config/agent-presets`（`system` root），bundle patch 里配的 roots 在桌面
  形态下不生效。app 用 `dsh.desktop.agentPresets` 声明随应用分发的 preset
  目录（包名 + 子路径，如 `@scope/pkg/presets`），工具把其内容复制到该挂载
  点；dev 项目里 dsh 包因此以真实副本装入——工作区链接指向只读的上游树，
  挂载点写不进去。

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
      "agentPresets": ["@morlay/dsh-preset/dist/presets"], // 随桌面分发的 preset 目录
    },
  },
}
```

`dsh.version` 是 `@deepseek-ai/dsh` 的依赖 spec：仓库内项目可配
`workspace:^`（从 vendor 源码解析），仓库外项目配具体版本（从 registry 安装）；
缺省时回退到工作区已解析的 dsh 版本。

## 运行流程

- **dev**：链接工作区依赖闭包 + desktop-host 到临时项目（dsh 包以真实副本
  装入，见「桌面 preset 物化」），host 用系统 node 直载工作区 TS 源码——仅当
  工作区装有 tsx 时才加 `--import=tsx/esm`（否则不注入 loader），
  `--allow-linked-profile` 放行工作区链接；`--web` 则准备 `web` profile 后
  启动 `dsh web`。
- **bundle**：`pnpm deploy --prod` 导出工作区闭包 → 种子
  （`dsh-home/profiles/desktop` + `.seed-hash` 指纹）→ 下载校验 Node 二进制
  （`prepare:runtime`）→ electron-builder 静态打包。指纹覆盖 app 工作区白名单、
  根 lockfile，以及闭包内每个本地源码包的产物内容（本地源码依赖的版本号
  不变、内容也可能变），指纹变化时壳在启动时替换 profile。闭包内 `@morlay/*`
  的 exports 切到 publishConfig 的 dist 产物（打包环境没有 tsx）。

## 运行时语义

- **XDG 路径**：`dshHome: xdg`（默认）→ `xdg.DataHome/<name>`（macOS
  `~/Library/Application Support`、Linux `$XDG_DATA_HOME`），与参考实现一
  致；`DSH_APP_DSH_HOME` 可覆盖（开发 / 测试）。
- **shell 注入**：Unix 上 host 经 `$SHELL -c 'source ~/.bashrc; exec …'`
  启动（bash/zsh），继承用户终端环境（API key 等）；`exec` 保持同进程，
  进程组终止语义不受影响。
- **morlay 插件适配**：desktop 模式禁用 `webserver`，`SessionEditor` 的
  HTTP 路由改经 `connection.fetch` 注册到 `/api/session-editor`（web 模式
  仍走 `webServer`）；客户端按 `__DSH_TRANSPORT__.ownsHost` 加 `/api` 前缀。

## 环境变量

| 变量                              | 作用                                               |
| --------------------------------- | -------------------------------------------------- |
| `DSH_DESKTOP_WORKSPACE`           | 目标工作区（位置参数会写入）                       |
| `DSH_DESKTOP_NODE_BINARY`         | dev / 打包后 host 使用的 node 可执行文件           |
| `DSH_DESKTOP_APPCONFIG_DIR`       | 覆盖 `appconfig.json` 所在目录（dev / 测试）       |
| `DSH_DESKTOP_SEED_DIR`            | 覆盖 profile 种子目录（dev / 测试）                |
| `DSH_DESKTOP_DEV_PROJECT_DIR`     | 覆盖 dev 临时项目目录                              |
| `DSH_DESKTOP_TSX_IMPORT`          | dev 启动器写入的 tsx loader spec（无 tsx 时为空）  |
| `DSH_DESKTOP_OPEN_DEVTOOLS`       | dev 是否自动打开 DevTools（默认 `1`，置 `0` 关闭） |
| `DSH_DESKTOP_HOST_INSPECT_PORT`   | host 调试端口（默认 9230）                         |
| `DSH_DESKTOP_MAIN_INSPECT_PORT`   | 主进程调试端口（默认 9229）                        |
| `DSH_DESKTOP_RENDERER_DEBUG_PORT` | 渲染进程调试端口（默认 9222）                      |
| `DSH_DESKTOP_TARGET_PLATFORM`     | `prepare:runtime` 目标平台（默认当前平台）         |
| `DSH_DESKTOP_TARGET_ARCH`         | `prepare:runtime` 目标架构（默认当前架构）         |
| `DSH_DESKTOP_DIAGNOSTIC_FILE`     | 壳启动失败时把错误栈写入该文件                     |
| `DSH_APP_DSH_HOME`                | 覆盖运行时 `DSH_HOME`（优先于 `dshHome` 配置）     |

## 前置条件

- pnpm workspace（dev 依赖 `findWorkspaceRoot` 装配临时项目；bundle 依赖
  `pnpm deploy`）。
- `vendor/deepseek-harness` 已构建（`just vendor prepare`：dev 需要 dsh CLI，
  工具构建需要 desktop-host 的 `lib/` 产物来 stage 进 `dist/desktop-host`）。
- 工具自身已构建（`pnpm build`）：dev / bundle 用 `dist/desktop-host` 里的
  后端产物。
