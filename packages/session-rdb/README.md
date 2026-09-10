# @morlay/session-rdb

RDB（SQLite / PostgreSQL）持久会话后端（`ctx.sessionPersistence`）：实现上游
`SessionHandle` 模型（`create`/`open`/`flush`/`stat`/`list`），支持配置选择
SQLite 或 PostgreSQL 后端。设计细节（表结构、原样存储、并发写、方言差异、
仓库结构）见 [docs/design.md](docs/design.md)。

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
      /** 目标 schema（默认 public，必须已存在）；见 docs/schema.md。 */
      schema?: string;
    };
```

## 分支能力（session-branch 闭环）

除 `ctx.sessionPersistence` 外，本包还实现 `@morlay/session-branch` 的
provider 抽象并**随插件自动注册 `ctx.sessionBranch`**（`SessionBranchRdb`），
在不修改上游代码的前提下提供 `rewind / retry / fork` 的持久化闭环：

- `forkFrom`：纯 append 从闭合边界派生新会话（事件行复用，不复制）；
- `rewind`：直接操作后端事务截断（只删桥接行），支持 live 与 cold 会话；
- `timeline`：lineage 版本树投影。

三个原语的完整语义（含 live 同步步骤、事件行复用机制、坐标论证与已知限制）
见 [docs/branch.md](docs/branch.md)。

上层编排（edit / reroll / retry / rewind / fork 完整功能）由
`@morlay/ui-conversation-message-actions` 提供，或直接在 `ctx.sessionBranch` /
`ctx.sessionEditor` 之上编程。

## storages 接管（workspace 与投影缓存）

`$DSH_HOME/storages` 不再产生文件：官方 `storage-json` 与
`session-projection-cache` 由 `@morlay/better-session` 的 patch 禁用，数据落本包
的语义专用表（表结构见 [docs/schema.md](docs/schema.md)，决策见
[docs/adr/0009](docs/adr/0009-接管storages到rdb语义表.md)）：

- **workspace 域**：官方 `workspace` 插件保留，本包在 storage hub 注册 `rdb`
  KV 后端（`storage-domain` 的 backend 路由为 `rdb`），记录、归属、显示顺序
  与归档分别落 `t_workspaces` / `t_workspace_sessions` / `t_workspace_state`
  与 `t_sessions.f_archived_at`；
- **投影 checkpoint**：本包提供 `ctx.sessionProjectionCache` 服务（替换官方
  插件，API 与语义逐一对齐），每个投影 key 一行落 `t_session_projcache_row`
  （identity 直接复用 `t_sessions` 的会话行）；SQLite 下读路径**直接查表**
  （进程内不再维护 checkpoint 镜像），PostgreSQL 因驱动异步保留写穿镜像。
- **会话标题是会话数据**：`t_sessions.f_title` 由 rdb 按 `session/title` 事件
  维护（rewind 截断后重算），列表消费在没有 checkpoint 行时直接取该列。

写节流参数（默认 200 / 5000，与官方 base 装配一致）可经 settings 覆盖：

```yaml
session-rdb:
  type: sqlite
  path: /absolute/path/to/sessions.sqlite
  projectionCache:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

旧 `storages` JSON 用显式命令导入（先停掉 dsh，旧文件保留不删）：

```sh
just import-storages --dsh-home apps/dsh-custom-next/.dsh-store \
  --path apps/dsh-custom-next/.dsh-store/sessions/sessions.sqlite
```
