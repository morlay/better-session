# 如何写

写代码时守的约束。判据来自既有决策（见各层 `.agents/adrs/`，当前决策在根 [`adrs/`](../adrs)
与各包 `.agents/adrs/`），冲突时按 ADR 走。

## 接缝在哪

改动前先定位这次要穿哪个接缝——它是调用方与测试共同的边界。测试只写在这些接缝上；
要越过接缝才能测，说明接缝放错了。下表里的守护测试路径相对 `packages/`
（`session/...` 即 `packages/session/...`）。

| 接缝                 | 位置                                                                                                     | 穿它验证什么（守护测试）                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 编排（host）         | `ctx.sessionEditor`：`edit` / `retry` / `reroll` / `recall` / `rewind` / `fork` / `timeline`             | 四个动作的编排语义与重放范围：`session/ui-conversation-message-actions/src/__tests__/{edit,retry,recall,branch,replay,plan}.spec.ts`                         |
| 传输（webServer）    | `POST` / `GET /session-editor`                                                                           | web 模式的 HTTP 面：同目录 `http.spec.ts`                                                                                                                    |
| 传输（宿主内嵌）     | `connection.fetch` 的 `/api/session-editor`：GET timeline、POST 六种动作、400 / 405 / 409                | desktop 等宿主内嵌传输：同目录 `http-connection.spec.ts`                                                                                                     |
| 数据（provider）     | `ctx.sessionBranch`（`readBranchPrefix` / `forkFrom` / `rewind`）+ `ctx.sessionPersistence`              | 持久化与分支数据面：`session/session-rdb/src/__tests__/{branch,rdb,deletion,import,pg}.spec.ts`                                                              |
| 水位与失效           | rewind / 覆盖导入后 token meter 折叠与投影单元缓存必须失效（同一 meter 实例 + 预热水位）                 | 失效时机与自愈：`session/ui-conversation-message-actions/src/__tests__/meter-watermark.spec.ts`、`session/session-rdb/src/__tests__/{branch,import}.spec.ts` |
| 契约投影             | `balanceRewindPrefix`（含 step 配平自愈与 `keepOpenTail`）/ `buildTimeline`                              | 版本树投影与日志不变量：`session/session-branch/src/__tests__/{balance,timeline}.spec.ts`                                                                    |
| 浏览器半（编排）     | `SessionEditorController.face`：recall 回填 composer、resync + 投影截断、版本导航、错误分支、`/api` 前缀 | client 侧编排与传输前缀：`session/ui-conversation-message-actions/src/__tests__/client-controller.spec.ts`                                                   |
| 浏览器半（入口门控） | `UserMessageNodeView`：编辑只要存在可编辑文本块（含轮外消息）、重试仅已闭合轮次、确认后才提交            | 编辑 / 重试入口的门控：同目录 `chat-node-actions.spec.tsx`                                                                                                   |
| 对话 UI 接管（chat） | `ui-chat` 的事件→视图投影、格式化工具、气泡 / 思考块渲染（props 面）                                     | `session/ui-chat/src/__tests__/*.spec.ts(x)`（含 `chat-projection` / `message-item`）                                                                        |
| 对话 UI 接管（外壳） | `ui-conversation` 的输入外壳与队列、消息定位与视图装配                                                   | `session/ui-conversation/src/__tests__/*.spec.ts(x)`（含 `input-shell` / `queue-dock` / `conversation-location-index`）                                      |
| 对话 UI 接管（输入） | `ui-input-trigger` 的触发检测、菜单归约、控制器链路与菜单渲染                                            | `session/ui-input-trigger/src/__tests__/*.spec.ts(x)`（含 `detect-trigger` / `menu` / `controller`）                                                         |
| 桌面化（工具）       | `dsh-desktopify` 的命令面、协议编解码、配置 / 路径推导、种子与壳工程产物                                 | `desktop/dsh-desktopify/src/__tests__/*.spec.ts`（含 `cli-surface` / `host-protocol` / `workspace-config`）                                                  |
| 装配面               | `better-session/cordis.patch.yml` ↔ 依赖 ↔ client 声明                                                   | 装配行可解析、依赖不漏装配、fork 包声明齐全：`session/better-session/src/__tests__/{patch,assembly}.spec.ts`                                                 |

## 分层与依赖方向

- **会话编辑四层**：契约层 `@morlay/session-branch`（provider 抽象 + 版本树投影）→ 编排层
  `@morlay/ui-conversation-message-actions`（`SessionEditor` 编排 + client bundle）→ 实现层
  `@morlay/session-rdb`（RDB 持久化 + branch provider + storages / 查询接管）；装配决策归聚合层
  `@morlay/better-session`（`cordis.patch.yml`）。结构见 [`0001 系统设计`](../designs/0001-系统设计.md)。
- **依赖单向**：编排 → 契约、实现 → 契约（`@morlay/session-rdb` 与
  `@morlay/ui-conversation-message-actions` 互不引用，两者只经 `ctx.sessionBranch` /
  `ctx.sessionPersistence` 这类服务面相遇）。装配层依赖全部其余包，反向依赖成环即错。
- **对话 UI 接管包不认识会话编辑语义**：`session/ui-conversation` / `ui-chat` / `ui-input-trigger`
  （上游 client 半 fork，见[债务 0001](../debts/0001-临时接管上游对话UI的client半.md)）与
  `client/ui-primitives` 只出渲染 / 输入 / 样式基础；编排层的 client 半在它们之上替换
  `conversation.chat.node` 的 `user` / `steering` 渲染并挂编辑 / 重试入口。
- **上游不可修改**：`vendor/**` 与 `node_modules` 只读；扩展走 cordis 插件层（plugin / patch bundle /
  settings namespace）。本地 patch 是例外，流程见 `dsh-plugin-upstream-sync` 技能。
- **工具链在根**：各包 `package.json` 只声明自身依赖；上游包以 `workspace:^` 声明在 `peerDependencies`
  （插件契约面）或 `devDependencies`（测试用，如 `dsh-token-meter`、`dsh-session-projection`）。

## 包出口

- **host 面（`.`）**、**子能力出口**（`./invariant`、`./plan`、`./artifact`、`./deletion`、`./import`、
  `./storage`）、**测试辅助**（`./testing`）、**浏览器半**（`./client`）、**装配声明**
  （`./cordis.patch.yml`）：谁能引到什么由 `exports` 决定，新面先加出口再引。
- **client 半是单文件 bundle**：`./client` 的 `default` 指向 `dist/client.cjs`（`types` 回源
  `src/client/index.ts`，便于 vitest 解析）——上游 client 半以浏览器模块工厂加载，多文件产物会破坏
  ModuleLoader 手递，约束与理由见
  [ADR-0002](../../packages/session/ui-conversation-message-actions/.agents/adrs/0002-客户端bundle单文件与shadow渲染替换.md)。
- **跨包共享的测试辅助走 `./testing`**，不进 host 面（`@morlay/session-rdb/testing`、
  `@morlay/ui-conversation-message-actions/testing`）。
- 装配链依赖 `./cordis.patch.yml` 出口：装配行按包名 + 出口解析，改名或挪出口会同时打断
  `better-session` 的装配面测试。

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
