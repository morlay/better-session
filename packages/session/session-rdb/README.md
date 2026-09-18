# @morlay/session-rdb

RDB（SQLite / PostgreSQL）持久会话后端（`ctx.sessionPersistence`）：实现上游
`SessionHandle` 模型（`create`/`open`/`flush`/`stat`/`list`），支持配置选择
SQLite 或 PostgreSQL 后端。表结构、原样存储与各条流程的设计见
[设计总览](.agents/designs/20260917-设计总览.md)，决策见 [`.agents/adrs/`](.agents/adrs)。

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
      /** 目标 schema（默认 public，必须已存在）。 */
      schema?: string;
    };
```

## 分支能力（session-branch 闭环）

除 `ctx.sessionPersistence` 外，本包还实现 `@morlay/session-branch` 的 provider
抽象并**随插件自动注册 `ctx.sessionBranch`**（`SessionBranchRdb`），在不修改上游
代码的前提下提供 `rewind / retry / fork` 的持久化闭环（原语：`forkFrom` 纯 append
派生、`rewind` 后端事务截断、`timeline` 版本树投影）——语义、坐标论证与已知限制见
[分支能力](.agents/designs/20260917-分支能力.md)。

上层编排（edit / reroll / retry / rewind / fork 完整功能）由
`@morlay/ui-conversation-message-actions` 提供，或直接在 `ctx.sessionBranch` /
`ctx.sessionEditor` 之上编程。

## 会话删除（仅已归档）

delete 面由本包自持：`deleteSession(id)` 只允许删除**已归档**会话（未归档报
`SESSION_NOT_ARCHIVED`），live（有打开的 handle 或未 materialize）报 `SESSION_LIVE`。

web 模式经 `POST /api/session.delete`（body `{ sessionId }`）暴露，状态映射：
200 已删除 / 404 不存在 / 409 未归档或 live。决策与边界见
[ADR-会话删除仅限已归档且硬删](.agents/adrs/20260917-会话删除仅限已归档且硬删.md)。

## storages 接管（workspace 与投影缓存）

`$DSH_HOME/storages` 不再产生文件：官方 `storage-json` 与
`session-projection-cache` 由 `@morlay/better-session` 的 patch 禁用，数据落本包的
语义专用表——workspace 域经本包注册的 `rdb` KV 后端，投影 checkpoint 经本包的
`ctx.sessionProjectionCache` 服务。表结构见
[表结构](.agents/designs/20260917-表结构.md)，决策见
[ADR-接管storages到rdb语义表](.agents/adrs/20260917-接管storages到rdb语义表.md)。

写节流参数（默认 200 / 5000，与官方 base 装配一致）可经 settings 覆盖：

```yaml
session-rdb:
  type: sqlite
  path: /absolute/path/to/sessions.sqlite
  projectionCache:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

旧 `storages` JSON 的导入是**包内 API**（先停掉 dsh，旧文件保留不删）——没有 CLI
入口、也不在 `exports` 里：

```ts
await importStorages(repository, { dshHome }); // 用法见 src/import-storages.ts
```
