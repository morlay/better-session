# 桌面化：从 golang 壳迁移到 Electron + 上游 desktop-host

## 状态

已实施（2026-09）。

## 背景

原桌面化方案（dsh-web-desktopify）用 Go 单命令：Wails v3 壳 + SEA 打包
的 dsh 后端 + 内容寻址构建 DAG。需要 golang 工具链，且 SEA 方案与上游
官方桌面实现（Electron + desktop-host 字节管道）分叉，维护两套后端启动
逻辑。

上游 `apps/desktop`（Electron 壳）与 `apps/desktop-host`（字节管道后端）
已随 vendor 完整可用：desktop-host 的 `lib/index.js` 是纯 node 实现，
`host-process.ts` / `host-protocol.ts`（协议版本 3）不依赖 electron，
可直接复用。

## 决策

- **壳**：Electron 主进程，复用上游 `host-process.ts` / `host-protocol.ts`
  （复制到 `devpackages/dsh-desktopify/src/`，纯 node 无 electron 依赖）。
  窗口生命周期、`dsh-app://` 自定义协议、host 守护与官方一致。
- **后端**：直接复用上游已构建的 `@deepseek-ai/dsh-desktop-host`，不重复
  实现 boot 逻辑。
- **工具形态**：`@morlay/dsh-desktopify` 提供 bin `dsh-desktopify`
  （`dev` / `bundle` / `build` / `prepare:runtime` / `prepare:seed`），
  工作区作为参数或 `DSH_DESKTOP_WORKSPACE` 传入（缺省当前目录），工具内
  不写死 app 路径或名字。
- **官方依赖内部维护**：`@deepseek-ai/*` 依赖清单（dsh、dsh-desktop-host、
  cordis-plugin-group 及约 20 个 peer 包）由工具内部维护，app 只声明自己
  的 morlay 依赖；dev 项目与打包闭包由工具装配，官方包经 `workspace:^`
  从 vendor 源码解析。
- **bundles 自动合并**：官方 bundles（`@deepseek-ai/dsh-base`、
  `@deepseek-ai/dsh-web-app`）+ app 的 `dsh.profile.bundles` 自动合并进
  dev 项目与种子 profile。
- **dev**：链接工作区（vendor dsh CLI + desktop-host + hoisted 闭包），
  host 用系统 node + `--import=tsx/esm` 直载 morlay TS 源码；
  `--allow-linked-profile` 放行工作区链接。**不用 Electron 内置 node**
  （Node 24 的 tsx strip-only 模式不支持 parameter properties，morlay
  TS 源码转换失败导致 boot 卡死）。
- **bundle**：`pnpm deploy --prod` 导出工作区闭包 → 种子
  （`dsh-home/profiles/desktop` + `.seed-hash` 指纹）→ 下载校验 Node 二进制
  → electron-builder `--dir` 静态打包（无签名、无 notarize、无开发者
  账号）。
- **XDG 路径**：`dshHome: xdg` → `xdg.DataHome/<name>`，与参考实现一致；
  `DSH_APP_DSH_HOME` 覆盖（开发/测试）。
- **shell 注入**：Unix 上 host 经 `$SHELL -c 'source ~/.bashrc; exec …'`
  启动（bash/zsh），继承用户终端环境；`exec` 保持同进程，进程组终止
  语义不受影响。
- **morlay 插件适配**：desktop 模式禁用 `webserver`，`SessionEditor` 的
  HTTP 路由改经 `connection.fetch` 注册到 `/api/session-editor`（web 模式
  仍走 `webServer`）；客户端按 `__DSH_TRANSPORT__.ownsHost` 加 `/api`
  前缀。种子闭包内 `@morlay/*` 的 exports 切到 publishConfig 的 dist
  产物（打包环境无 tsx）。

## 关键实现细节

- **启动顺序**：必须先 `startHost()` 再 `loadURL()`（官方同序）——页面
  首帧即拿到后端，否则拿到 503 且不自动重载。
- **DSH_HOME 显式设置**：用户 shell 环境可能残留旧应用的 DSH_HOME
  export，host 经 shell 注入启动时会继承它——壳启动 host 时显式传
  `DSH_HOME`。
- **种子复制**：deploy 闭包先以 pnpm `nodeLinker: hoisted` 拍平（顶层真实
  目录、无虚拟存储、无外部链接），再原样复制进种子；`seed.ts` 复制时保留
  符号链接原样（相对链接指向闭包内副本），不解引用。
- **peer 闭包**：`pnpm deploy --prod` 不装 peerDependencies，desktop-host
  boot 依赖的 `@deepseek-ai/*` peer 包（cordis-plugin-group 等 20 个）
  由工具注入为 `workspace:^` 依赖（deploy 目标生成的 pnpm-workspace.yaml
  已指向仓库成员，从 vendor 源码解析进闭包）。
- **connection 服务时序**：`SessionEditor` 构造时 connection 可能已
  provide（事件已错过）——监听 `internal/service` 事件并立即检查一次。

## 影响

- 去掉 golang 依赖：`mise.toml` 不再需要 go，构建链全为 pnpm + node。
- 静态打包：electron-builder `--dir` 产出未签名 `.app`，无需开发者账号。
- 与上游官方桌面实现共享 host 协议与后端，升级时只需跟随 vendor 版本。
