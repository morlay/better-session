# 如何验证（纯 node 面与未覆盖面）

通用规则（证据矩阵、失败处理、发布纪律）见根[如何验证](../../../../../.agents/standards/how-to-verify.md)；
这里只写本包的落点与未覆盖清单。

## 按接缝测（纯 node）

`src/__tests__/` 覆盖命令面、协议编解码、配置 / 路径推导、种子与壳工程产物：

- **协议 / 宿主**：`host-protocol.spec.ts`（协议常量与编解码）、`host-process.spec.ts`；
- **文档 / 认证 / 转发**：`web-document.spec.ts`；
- **命令面与配置**：`cli-surface.spec.ts`、`workspace-config.spec.ts`、`appconfig.spec.ts`、
  `dshhome.spec.ts`、`shell-env.spec.ts`、`shell-app-directory.spec.ts`、`dev-*.spec.ts`；
- **种子 / 部署 / 运行时闭包**：`seed-*.spec.ts`、`deploy-*.spec.ts`、`official-*.spec.ts`、
  `runtime-packages.spec.ts`、`prepare-runtime-target.spec.ts`、`agent-presets.spec.ts`、
  `office-assets.spec.ts`。

## 未覆盖（有明确原因）

- **Electron 主进程 / preload / `cli/{bundle,dev}.ts` 私有逻辑**：导入即触发 `app.whenReady()` 等
  副作用，需要整套 Electron mock 面——真实启动见该包[设计 桌面化工具](../designs/20260917-桌面化工具.md)
  与其中链接的打包器 ADR。
