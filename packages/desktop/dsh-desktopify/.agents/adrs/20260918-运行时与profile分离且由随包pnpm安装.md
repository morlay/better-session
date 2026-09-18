# ADR-20260918-运行时与profile分离且由随包pnpm安装

状态：已采纳
范围：`packages/desktop/dsh-desktopify/` 的打包种子布局与 profile 安装方式。

## 背景

桌面打包产物要支持 Web 插件页（`@deepseek-ai/dsh-plugin-manager`）的安装 / 卸载 / 启停。原先的种子只有一个
`dsh-home/profiles/desktop`：它是 `pnpm deploy` 闭包的复制品，而 `package.json` 却是 app 自己的 manifest
（依赖里带 `workspace:^`）。在打包产物里用插件页做包操作时，pnpm 拿到的是一份与磁盘不一致的依赖图
（手工复制进闭包的包不在图里），任何 `install` / `add` 都会把那些包 prune 掉；随后启停触发的 Loader 解析就
报模块解析错误。同时，壳当时也没有把 pnpm 交给 host（缺 `profileContext.packageManager`）。

## 决策

把打包种子拆成两棵树，并让 profile 由随包 pnpm 离线安装：

- `seed/runtime`：不可变的 deploy 闭包，随包留在应用只读 resources 里，充当 host 的 dsh 安装锚点、前端静态
  资源与 preset 物化目标；
- `seed/profiles/desktop`：初始 profile，只声明 app 自己的 bundle（`file:./vendor/<name>`，`vendor/` 是从
  runtime 闭包 deref 复制出来的源）；
- 壳在种出 profile 后写入 `overrides`（`"@deepseek-ai/x": "link:<runtime>/node_modules/@deepseek-ai/x"`），
  再用随包 node 跑随包 pnpm 的 `install --prod --ignore-scripts --offline`；
- 壳把随包 pnpm 与 node bin 目录经 host argv[6]/[7] 交给 host，成为 `profileContext.packageManager`。

## 理由

- profile 必须是 pnpm 能接管的真项目，插件页的包操作与启停才能在打包产物里工作；分离后 profile 的依赖图与
  磁盘一致，官方包与 dsh 由 runtime 提供，不需要在 profile 里复制一份 1.3G 闭包。
- 与上游桌面形态一致：它同样把 core 包排除在 profile 之外（由签名 runtime 提供），并把随包 pnpm 经 argv 交给
  host；`link:` 覆盖让 profile 里插件的 `@deepseek-ai/*` 依赖共享 runtime 的同一份实例（cordis 尤其）。
- 离线安装成立：依赖全是 `file:` 源与 `link:` 覆盖，首次启动不访问 registry。

## 后果

- 指纹变化时，壳在启动 host 前多一步 profile 安装；`DSH_HOME` 不再持有运行时副本。
- 旧形态的 profile 会被整体替换：用户此前在该 profile 里装的插件需要重新安装，手写的 `cordis.patch.yml`
  改动也会丢（这是种子替换既有的语义，本次不扩大）。
- `pnpm-workspace.yaml` 的 `overrides` 由壳写入；种子报告的运行时包列表为空时不动文件，保留手写内容。
- profile manifest 不再带 app 的 `dsh.version` / `desktop` / `dev`（那些是打包输入）；运行时不再从 profile 读它们。
