# 如何验证

「验证过」= 有**最小充分**的证据，并且贴出真实输出。命令入口在根 [`justfile`](../../justfile)
（`just --list`），版本见 [`mise.toml`](../../mise.toml)。

## 证据矩阵

按改动落在哪选证据，够用就好——不要反射式跑全量：

| 改动                        | 至少跑                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| 单包源码                    | 该行为对应的测试（`just test <受影响的 spec>`，见「接缝在哪」的表） |
| 跨包契约 / 公共类型面       | 涉及包的测试，加全量 `just test`                                    |
| 测试 / 构建配置、依赖       | 全量 `just test`                                                    |
| 浏览器半（client bundle）   | 相关 jsdom 用例 + `just build`                                      |
| 包出口、构建路径            | `just build`                                                        |
| 文档与记录                  | 相对链接可达、无悬挂引用                                            |
| vendor 上游（同步 / patch） | 全量 `just test` + `just lint` + `just build`                       |

## 测试落点

下文路径均相对 `packages/`。

- 位置：各包 `src/__tests__/`（vitest include `packages/**/src/__tests__/**/*.spec.ts(x)`，
  exclude `node_modules` 与 `target`）；共享辅助放该包 `src/testing/`，经 `./testing` 出口暴露。
- 环境：
  - RDB 测试用 SQLite `:memory:`；
  - PostgreSQL 契约测试（`pg.spec.ts`）需要 `TEST_PG_URL`：本地用 `just pg test`（docker compose
    起库并注入连接串），CI 由 postgres service 提供；未设置时 `describe.skipIf` 自动跳过；
  - Seatbelt e2e（`sandbox/dsh-sandbox-local/src/__tests__/seatbelt.e2e.spec.ts`）只在 macOS 且
    `/usr/bin/sandbox-exec` 可用时执行——CI（ubuntu）恒跳过，属本地人工验证；
  - 浏览器半测试用文件头 `// @vitest-environment jsdom`（vitest 未开 globals，
    `@testing-library/react` 需在 spec 里显式 `cleanup`）。
- **测试描述行为，不描述实现**：行为变更必须连同测试一起改。
- 测试装配辅助：
  - `@morlay/session-rdb/testing`：`EmptySettings`（空 settings provider，满足
    `static inject: ['settings']`）、`new SessionProjectionRegistry(ctx)`，契约 fixture 在
    `contract.ts` / `coordinator-contract.ts`；
  - `@morlay/ui-conversation-message-actions/testing`：`harness()` 一次性装配 `EmptySettings` +
    `SessionStore` + 投影注册 + 真实 SQLite rdb + `SessionEditor`，并导出 `twoTurnLog` /
    `createPersisted` 等日志 fixture；
  - 分支语义的端到端用例见 `branch.spec.ts` / `edit.spec.ts`（真实 SQLite 后端 + coordinator
    状态同步 + duck-typed agent 驱动）。
- **fork 包的口径**：`session/ui-conversation`、`session/ui-chat`、`session/ui-input-trigger` 是从上游
  整包复制、**由我们维护**的包——既然由我们维护，就要按接缝测，不能以「上游代码」为由留空白：
  - **核心纯逻辑**（事件→视图投影、消息定位、输入 / 队列状态机、引用检测与菜单、工具树 / steering
    历史）→ node 环境单测；
  - **用户可见组件**（user 气泡渲染、队列行、引用菜单、输入框）→ jsdom 组件测试；
  - **不单独测**：`.styles.ts` 样式表与 locale 数据表（机制由 `packages/client/ui-primitives` 的
    styling / token 测试覆盖）、纯类型与桶文件。
  - fork 源码没有 lint / fmt 豁免（`.oxlintrc.json` / `.oxfmtrc.json` 只忽略 `target`、`lib`、
    `**/dist/**`），与上游的差异登记及回退条件见
    [债务 0001](../debts/0001-临时接管上游对话UI的client半.md)。
- **已知未覆盖（有明确原因，不是遗漏）**：

  | 位置                                                                                                                                                                                           | 原因                                                                                                                                                                                              |
  | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | fork 三包与编排层的 **slot 装配面**（各 `client/apply.ts`、`ui-conversation` 的 `client/skeleton/*` / `client/service.ts`、`ui-chat` 的 `ChatView` / `*NodeView` / `register-node-renderers`） | 需要 cordis client 运行时（slots 声明者 / 注册表、locale、renderer、sessions 面）；上游 client 半是浏览器模块工厂，node 不可加载 → [债务 0002](../debts/0002-对话UI客户端半的装配面缺测试辅助.md) |
  | `dsh-desktopify` 的 Electron 主进程 / preload / `cli/{bundle,dev}.ts` 私有逻辑                                                                                                                 | 导入即触发 `app.whenReady()` 等副作用、host 子进程 spawn 无注入点；需要整套 Electron mock 面（见 [ADR-0003](../adrs/0003-桌面化从golang壳迁移到Electron与上游desktop-host.md)）                   |
  | `session/ui-conversation-message-actions` 的 `importSession` 浏览器半                                                                                                                          | `FileReader` + `location.reload()` 薄壳；服务端面由 `session-rdb` 的 `import.spec.ts` 覆盖                                                                                                        |
  | `pg.spec.ts`（本地）/ `seatbelt.e2e.spec.ts`（CI）                                                                                                                                             | 环境门控，见上面的「环境」条目                                                                                                                                                                    |

## 交付与发布

- **发布走 CI**：`.github/workflows/release.yml`（`main` 与 `next` 分支：`vendor prepare` → `dep` →
  `build` → `lint` → `test`（注入 `TEST_PG_URL`）→ `build` → GitHub Packages publish）。
- **严禁本地私自 `pnpm publish`**（包括用 `--registry` 指向 GitHub Packages 的发布）。版本 bump
  提交后由 CI 发布；本地只构建验证。
- 改动收尾时 `just lint` 只要不引入**新**错误即可，必要时 `just fmt`。

## 失败怎么处理

- 相关检查失败就停下修掉，或说明阻塞点；不要推着「CI 可能会过」往下走。
- 看起来像环境问题的，先证明：记下确切命令、失败用例、平台差异（如 seatbelt / postgres 门控），
  再判断是环境还是回归。
- 不要为了过验收放宽检查（降低阈值、跳过用例、缩小覆盖范围），也不要改断言来迁就实现。
