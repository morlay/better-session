# 桌面未随包 primary runtime 载荷

状态：未销账（`load_workspace_dependencies` 工具在桌面形态下必然失败：payload 目录不存在）

**现象**

alpha.2 的 desktop-host 把 argv[4] 当 bundled 依赖载荷源交给
`apps/desktop-host/src/workspace-dependencies.ts`：`installPrimaryRuntime(source, root)` 读
`<source>/runtime.json`，并把 `<root>=<DSH_HOME>/dsh-runtimes/dsh-primary-runtime` 装成
Python / numpy / pandas / Node / pnpm 的绝对路径（`apps/desktop-host/src/primary-runtime.ts`
的 `readPrimaryRuntime` / `installPrimaryRuntime`）。

我们的壳按上游约定把 argv[4] 指到 `<runtime 根>/primary-runtime`
（`packages/desktop/dsh-desktopify/src/index.ts` 的 `runtimeResources()`；dev 经
`DSH_DESKTOP_PRIMARY_RUNTIME_DIR`），但 `dev` / `bundle` 都不生成这个目录：

```
$ ls apps/dsh-custom-next/node_modules/.dsh-desktopify/runtime
appconfig.json  node  versions.json
```

上游自己的 `apps/desktop/scripts/prepare-primary-runtime.ts` 要下载平台 Python（含 numpy /
pandas / python-docx 等 wheel）与 pnpm，并做 smoke 执行；我们没走这一步。

**现状（`dsh-v0.1.6-alpha.2`）**

`office-skills` 资源已随包：`dev` 与 `bundle` 都会把 `@deepseek-ai/dsh-skill-office/assets`
拷到 `primary-runtime` 的同级 `office-skills`（`packages/desktop/dsh-desktopify/src/cli/office-assets.ts`，
缺 `scripts/check_office.py` 即失败）—— 因此 Host 启动的 Office 硬要求已满足。
剩余缺口只有 `primary-runtime` payload 本体（`runtime.json` + python / node / pnpm）。

**影响**

桌面会话里调用 `load_workspace_dependencies` 工具会以 `primary runtime: ...` 的 ENOENT /
`readPrimaryRuntime` 报错失败（安装是惰性的，**不阻塞 Host 启动**）。撞上的是让模型用 bundled
Python 处理脚本类任务的用户；其余会话不受影响。

**触发条件**

动到 bundled Python / pnpm 依赖装载、或需要桌面形态与官方桌面在 Office / 脚本能力上对齐之前。

**销账条件**

Done when：`dev` 与 `bundle` 产物里都有可用的 `primary-runtime` payload（`runtime.json` +
`dependencies/{python,node,pnpm}`），且 `load_workspace_dependencies` 返回的路径可执行通过
上游 `smokePrimaryRuntime` 同等的检查。

**不修的理由**

payload 是几十到上百 MB 的平台资产（上游单独跑下载 + 校验 + smoke），当前桌面化目标是「能跑
morlay 的会话插件」；随包 Node 已经从 Node 官方 SHASUMS 校验下载，再加一条 Python 载荷线属于
另一件事。缺了只影响一个工具，且失败是显式的。
