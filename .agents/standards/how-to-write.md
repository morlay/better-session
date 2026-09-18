# 如何写

写代码时守的约束。判据来自既有决策（见各层 `.agents/adrs/`，当前决策在根 [`adrs/`](../adrs)
与各包 `.agents/adrs/`），冲突时按 ADR 走。

## 接缝

- **接缝 = 接口即测试面**：改动前先定位这次要穿哪个接缝——它是调用方与测试共同的边界，测试只写在这些
  接缝上。**想越过接口去测，说明接口形状不对**：先改接口，再测。
- **包特有的接缝与判据在该包 `.agents/standards/`**：具体接缝与它对应的守护 spec 就近查，
  这里不索引、不复述。

## 分层与依赖方向

- **依赖单向**：编排 → 契约、实现 → 契约；实现层与编排层互不引用，两者只经 `ctx.sessionBranch` /
  `ctx.sessionPersistence` 这类服务面相遇。装配层依赖其余包，反向依赖成环即错。
  分层结构与各层职责见[系统设计](../designs/20260917-系统设计.md)。
- **引入 vendor 源码的包（薄壳 fork）**：这类包把上游源码拉进同一个 TS program，因此对 tsconfig 与
  合并接口有额外硬约束——见该包层规范。
- **上游不可修改**：`vendor/**` 与 `node_modules` 只读；扩展走 cordis 插件层（plugin / patch bundle /
  settings namespace）。本地 patch 是例外，流程见 `dsh-plugin-upstream-sync` 技能。
- **工具链在根**：各包 `package.json` 只声明自身依赖；上游包以 `workspace:^` 声明在 `peerDependencies`
  （插件契约面）或 `devDependencies`（测试用）。

## 包出口

- **谁引到什么由 `exports` 决定**，新面先加出口再引。出口分五类：**host 面**（`.`）、
  **子能力出口**（按域拆分）、**测试辅助**（`./testing`）、**浏览器半**（`./client`）、
  **装配声明**（`./cordis.patch.yml`）。
- **client 半是单文件 bundle**：`./client` 的 `default` 指向 `dist/client.cjs`（`types` 回源
  `src/client/index.ts`，便于 vitest 解析）——上游 client 半以浏览器模块工厂加载，多文件产物会破坏
  ModuleLoader 手递，约束与理由见
  [ADR-20260917-客户端bundle单文件与shadow渲染替换](../../packages/session/ui-conversation-message-actions/.agents/adrs/20260917-客户端bundle单文件与shadow渲染替换.md)。
- **跨包共享的测试辅助走 `./testing`**，不进 host 面。
- **装配链依赖 `./cordis.patch.yml` 出口**：装配行按包名 + 出口解析，改名或挪出口会打断装配面测试。

## 代码约定

- **类型安全**：`strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
  （`devpackages/devkit/tsconfig.json`）。跨边界 id 使用 branded 类型（如 `SessionId`），不做裸
  `string`。**类型检查由 `just lint` 承担**（oxlint 的 `typeAware` + `typeCheck`，后端
  `oxlint-tsgolint`）——本仓库没有独立的 `tsc` 步骤，类型报错就是 lint 报错。
- **`node/no-sync` 全开、无豁免**：运行时代码、测试与脚本（含 `.agents/skills/` 的同步 / patch / build
  脚本）一律用异步 node API（`node:fs/promises`、`promisify(execFile)`、`spawn` + Promise 包装），
  不用 `*Sync` 变体。`node:sqlite` 的 `DatabaseSync` 与 better-sqlite3 的同步用法是该驱动的语义、
  不是本规则目标。
- 文件以单个换行结尾。
- **注释不做设计说明**；**不用 JSDoc**。
