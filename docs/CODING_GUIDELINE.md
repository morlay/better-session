# 项目约定

本仓库是 pnpm workspaces monorepo。工具链集中在根；各包只声明自身运行时
依赖。所有命令入口见 [justfile](../justfile)，版本见 [mise.toml](../mise.toml)。

## 技术栈

| 项         | 值                                              | 位置                |
| ---------- | ----------------------------------------------- | ------------------- |
| node       | 26                                              | mise.toml           |
| pnpm       | 12                                              | mise.toml           |
| just       | latest                                          | mise.toml           |
| 上游版本   | `DEEPSEEK_HARNESS_VERSION`                      | mise.toml           |
| 构建       | tsdown（rolldown）                              | 根 devDependencies  |
| 类型检查   | typescript（strict + noUncheckedIndexedAccess） | 根 tsconfig.json    |
| 测试       | vitest                                          | 根 vitest.config.ts |
| lint / fmt | oxlint / oxfmt                                  | 根 devDependencies  |

## 常用命令

```sh
just dep         # pnpm install（含 vendor side workspace）
just build       # 构建全部包（pnpm -r --filter './packages/*' run build）
just test        # vitest run
just lint        # oxlint
just fmt         # oxfmt
just update      # taze latest 升级依赖（-w 写回）
just clean       # 清理 lock 与构建产物

just vendor::sync   # 同步上游 deepseek-harness 到 vendor/（clone + patch）
just vendor::build  # 上游构建（vendor 目录内）
just custom::dev    # 本地 GUI 开发（dsh-web-desktopify）
just custom::bundle # 本地 GUI 打包
```

## 代码约定

- **上游 `@deepseek-ai/*` 不可修改**：node_modules 只读；扩展走 cordis
  插件层（plugin / patch bundle / settings namespace）。
- **工具链在根**：各包 `package.json` 只声明自身依赖；上游包以
  `workspace:^` 声明在 `peerDependencies`（插件契约面）或
  `devDependencies`（测试用，如 `dsh-token-meter`、`dsh-session-projection`）。
- **类型安全**：`strict: true` + `noUncheckedIndexedAccess` + `skipLibCheck`。
  跨边界 id 使用 branded 类型（如 `SessionId`），不做裸 `string`。
- **公开 API 用 JSDoc 说明**（含 `@param` / `@returns` / `@internal`）；
  注释与文档贴近代码，一句话一个要点。
- **测试描述行为，不描述实现**：行为变更必须连同测试一起改。
- 文件以单个换行结尾。

## 测试约定

- 测试位于各包 `src/__tests__/`（vitest 配置 `packages/*/src/__tests__/**/*.spec.ts`）。
- RDB 测试用 SQLite `:memory:`；PostgreSQL 契约测试（`pg.spec.ts`）需要
  `TEST_PG_URL`，本地未设置时自动跳过（CI 提供 postgres service）。
- 测试装配模式（见 `packages/session-rdb/src/__tests__/testing/helpers.ts`）：
  - `EmptySettings`：空 settings provider，满足 `static inject: ['settings']`。
  - `new SessionProjectionRegistry(ctx)`：`TokenMeter` 等上游服务要求
    `ctx.sessionProjections` 可用时在 harness 中实例化。
- 分支语义的端到端用例见 `branch.spec.ts` / `editor.spec.ts`（真实 SQLite
  后端 + coordinator 状态同步）。

## 发布

- **发布走 CI**：`.github/workflows/release.yml`（main 分支：lint + test +
  build → GitHub Packages publish）。
- **严禁本地私自 `pnpm publish`**（包括用 `--registry` 指向 GitHub
  Packages 的发布）。版本 bump 提交后由 CI 发布；本地只构建验证。

## 上游更新

上游 deepseek-harness 以 side workspace vendor 到 `vendor/deepseek-harness/`。
更新流程与本地 patch 说明见 [vendor/README.md](../vendor/README.md)。
