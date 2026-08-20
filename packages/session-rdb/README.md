# @morlay/session-rdb

RDB（SQLite / PostgreSQL）持久会话后端（`ctx.sessionPersistence`）：通过 drizzle
实现 `PersistenceBackend<number>`，复用上游 `PersistenceCoordinator` 与契约测试套件，
支持配置选择 SQLite 或 PostgreSQL 后端。设计细节（表结构、delta 过滤、并发写、
方言差异、仓库结构）见 [docs/design.md](docs/design.md)。

## 安装

包发布在 GitHub Packages，按包名安装到 dsh profile（示例：web；`dsh plugin
add` 把参数原样转发给 pnpm，版本号按发布版本调整）。registry 必须限定在
`@morlay` scope（`--config.@morlay:registry=…`），不要用全局 `--registry`，
否则依赖（`@deepseek-ai/*` 等）也会被指到 GitHub Packages 而解析失败：

```sh
dsh plugin --profile=web add "@morlay/session-rdb"
```

GitHub Packages 的 registry 要求认证（公开包也一样）：profile 的 `.npmrc`
需为 `npm.pkg.github.com` 配置访问 token（如
`//npm.pkg.github.com/:_authToken=<token>`），详见
[GitHub 文档](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)。

## 配置

配置写在 `${DSH_HOME}/settings.yaml`，settings namespace 为插件短名
`session-rdb`（与 cordis 插件 `name` 一致）：

```yaml
session-rdb:
  type: sqlite
  # path 省略时回落 cordis.patch.yml 的默认（$DSH_HOME/sessions/sessions.sqlite，
  # 由 bundle patch 的 !!js 表达式求值）；自定义路径请用绝对路径字符串。
  path: /absolute/path/to/sessions.sqlite
  journalMode: wal
  busyTimeout: 5000
```

> settings.yaml 是纯 YAML（settings-local 用 `yaml` 库解析），**不支持 `!!js`
> JS 表达式**——`!!js dshHomePath(...)` 会被当作字面字符串。`!!js` 只在
> `cordis.patch.yml`（bundle patch 层，loader 求值）有效。

字段即 Config 判别联合（见下）；未写出的字段回落到 bundle patch / cordis.yml 的
config 默认值。PostgreSQL：

```yaml
session-rdb:
  type: postgres
  connectionString: postgres://user:pass@localhost:5432/sessions
```

Config 类型：

```ts
type Config =
  | {
      type: "sqlite";
      /** SQLite 数据库文件路径；`:memory:` 用于测试。 */
      path: string;
      /** journal_mode：`wal`（默认）/ `delete` / `truncate` / `persist`。 */
      journalMode?: "wal" | "delete" | "truncate" | "persist";
      /** 写锁竞争等待毫秒数（默认 5000）。 */
      busyTimeout?: number;
    }
  | {
      type: "postgres";
      /** node-postgres 连接串；首次打开自动建表并写入 store 身份。 */
      connectionString: string;
    };
```

## 分支能力（session-branch 闭环）

除 `ctx.sessionPersistence` 外，本包还实现 `@morlay/session-branch` 的
provider 抽象并**随插件自动注册 `ctx.sessionBranch`**（`SessionBranchRdb`），
在不修改上游代码的前提下提供 `rewind / retry / fork` 的持久化闭环：

- **`forkFrom`**：走标准 coordinator 路径（`create` + `append`）从闭合边界
  派生新会话（纯 append，`parentSession` / `seedLength` lineage）；
- **`rewind`**：直接操作后端事务截断到闭合边界（DELETE 尾部 + head 回退 +
  revision bump），随后重新 `load` 同步 coordinator 状态，并更新并发写
  检测 head；**支持 live 会话**（`ctx.sessions` 有 owner 时同样就地工作：
  先 flush write-behind 缓冲 → 截断 RDB → 截断 live 内存 log 并复位
  surface/header/context/derived 派生缓存 → 重置 agent 请求头标记 →
  同步 coordinator cursor；不调用 `load`——live 时 load 会先 flush 撤销
  截断）；
- **`timeline`**：`parentSession` + `seedLength` 版本树投影（live 会话含
  版本效果；cold 会话因版本事件携带 `ignorable` 不进 canonical log 而只有
  lineage 骨架）。

上层编排（edit / reroll / retry / rewind / fork 完整功能）由
`@morlay/ui-conversation-message-actions` 提供，或直接在 `ctx.sessionBranch` /
`ctx.sessionEditor` 之上编程。
