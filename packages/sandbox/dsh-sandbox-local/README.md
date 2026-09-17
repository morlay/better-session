# @morlay/dsh-sandbox-local

可配置沙箱 bundle：替换官方 `ctx.sandbox`（进程沙箱）与 `ctx.fs`（文件系统围栏），
在官方语义之上叠加 `access` 规则——`rw <path>` 追加工作区之外的可写根，
`r- <path>` 只读（读放行、写拒绝），`-- <pattern>` 拒绝访问（读与写都拒）。

## 为什么

上游沙箱策略只有两个字段：`mode`（`read-only` / `workspace-write` /
`danger-full-access`）与 `workspaceRoot`；`workspace-write` 的可写路径是硬编码的
`[工作区, /tmp, os.tmpdir()]`（`vendor/deepseek-harness/packages/sandbox/sandbox/src/roots.ts:52-55`），
没有任何追加可写根或拒绝项的配置面。于是「让 agent 能写 `$XDG_CACHE_HOME`，
但永远不许碰项目里的 `mise.*.toml`」这类诉求只能整块放弃隔离。上游自己实现过拒绝项
（`readDenyPaths`）又撤回：bwrap 要在已置只读的树里创建挂载点、Landlock 无法从自己的
`/` 读授权里减除，一个「在能生效的地方破坏隔离、在不能生效的地方谎报」的保护被判为
不如明确的缺失（`vendor/deepseek-harness/.agents/notes/implemented/architecture/2026-07-30-credential-boundaries-and-atomic-registration.md:29`）。

本包把「能表达多少就说多少」明确下来：Seatbelt 完整生效，其余平台按方言降级，
并在加载期告警，而不是静默失效。

## 行为

替换两个服务，规则在两个入口保持同一语义：

| 条目        | `ctx.fs`（read / write / edit / list 工具）  | `ctx.sandbox`（bash 等子进程）                                                                      |
| ----------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `-- <path>` | 任何模式下读与写都拒（`resolve` 入口即拦截） | Seatbelt：读 + 写；bwrap：退化为只读；Landlock / Windows ACL：无表达（加载期告警）                  |
| `r- <path>` | 任何模式下读放行、写拒绝（优先于可写根）     | Seatbelt：`(deny file-write* …)`；bwrap：`--ro-bind-try`（只读挂载）；Landlock / Windows：无表达    |
| `rw <path>` | `workspace-write` 下计入可写根               | Seatbelt：`(allow file-write* (subpath …))`；bwrap：`--bind-try`；Landlock：`--rw`；Windows：无表达 |
| 无条目      | 与官方 `fs-sandbox` 行为一致                 | 与官方 argv 逐字一致（不做任何改写）                                                                |

- **进程沙箱侧是复用，不是重写**：`ConfigurableSandboxProvider` 继承官方
  `LocalSandboxProvider`，`confine` 先走 `super.confine()`（runner 探测与选择、
  Windows ACL 私有 temp、拒绝方言与 runner 失败规则全部保留），再按方言把规则追加到
  返回的 argv 上。
- **Seatbelt 规则追加在 profile 末尾**：SBPL 的后置规则覆盖先置规则，因此
  `(deny file-read* file-write* …)` 能压过官方已写入的 `(allow file-write* (subpath …))`；
  已用真实 `sandbox-exec` 验证（`src/__tests__/seatbelt.e2e.spec.ts`）。
- **三类条目在两个入口同步**：上游把 `writableRoots` 同时喂给 Seatbelt profile 与
  进程内 fs 围栏，只改一侧会造出「bash 能写、write 工具不能写」的裂缝。
- **命中优先级 `--` > `r-` > `rw` / 平台可写根**：显式拒绝覆盖只读声明，只读声明覆盖
  更宽的可写授予（例如 `rw {{ env.XDG_DATA_HOME }}` 与 `r- {{ env.XDG_DATA_HOME }}/secrets`
  同时存在时，后者胜）。
- **`r-` / `--` 条目在 `danger-full-access` 下仍然生效**（`ctx.fs` 侧）：它们是显式写下的
  用户规则，不是模式的推论；进程沙箱侧在 `danger-full-access` 下不经过沙箱，本包也无从施加。

## 配置

| 字段                      | 默认            | 含义                                                                                          |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `access`                  | `[]`            | 规则条目：`rw <path>` 可写根 / `r- <path>` 只读 / `-- <pattern>` 拒绝访问；数组或一段多行文本 |
| `runnerCommand`           | `[]`            | 透传官方 `sandbox-local`：替换 runner argv（配置了它就不能用规则）                            |
| `runnerFailureSignatures` | `[]`            | 透传官方 `sandbox-local`：自定义 runner 的失败签名                                            |
| `probeTimeoutMs`          | `5000`          | 透传官方 `sandbox-local`：候选 runner 的探测超时                                              |
| `cwd`                     | `process.cwd()` | 透传官方 `fs-local`：相对路径的解析基准                                                       |
| `diffBasisMaxBytes`       | `10485760`      | 透传官方 `fs-local`：overwrite diff 单侧字节上限                                              |

两种写法等价（数组每项一条，或多行文本每行一条；多行文本的空行忽略）：

```yaml
- id: sandbox-local
  config:
    access:
      - "rw {{ env.XDG_CACHE_HOME }}"
      - "r- {{ env.XDG_CONFIG_HOME }}"
      - "-- mise.*.toml"
      - "-- **/*.pem"
```

```yaml
- id: sandbox-local
  config:
    access: |-
      rw {{ env.XDG_CACHE_HOME }}
      r- {{ env.XDG_CONFIG_HOME }}
      -- mise.*.toml
      -- **/*.pem
```

条目语法：

- 每条必须以 `rw ` / `r- ` / `-- ` 开头；缺前缀、或前缀后没有路径，加载即失败（规则
  不因写法歧义而变形）。
- 语义：`rw` 允许读写；`r-` 只允许读；`--` 读与写都拒绝。优先级 `--` > `r-` > `rw`。
- `{{ env.NAME }}` 在加载期按进程环境展开；变量未设置或为空时插件加载失败。
- 相对路径相对**会话工作区**（不是 `cwd` 配置项）解析。
- `r-` 与 `--` 条目接受 glob：`*` 与 `?` 不跨 `/`，`**` 跨层级（`**/` 也匹配零层），
  `[!ab]` 取反；生成的正则同时用于进程内匹配与 SBPL 的 `(regex #"…")`，因此只用两者
  共有的语法。
- 字面（无通配）的 `r-` / `--` 条目命中自身**及其全部后代**；`rw` 条目必须是具体路径
  （可写根没有「通配」语义）。

## 装配

本包自带 `cordis.patch.yml`（禁用官方两行 + 插入自己的一行），把本包作为独立 bundle 采用
的部署直接列进 `dsh.profile.bundles` 即可；行不带 config（schema 默认是空规则）：

```yaml
- id: sandbox
  disabled: true

- id: fs-sandbox
  disabled: true

- insert:
    - id: sandbox-local
      name: "@morlay/dsh-sandbox-local"
```

**本部署（`@morlay/dsh-preset`）不走这条路径**：它的 patch 自己禁用官方两行、插入
`- id: sandbox-local` 行并写上规则，因此示例 app 的 `dsh.profile.bundles` 不需要列出本包，
只需要 profile 的依赖树能解析模块名（`@morlay/dsh-preset` 已在 `dependencies` 声明本包）。
两种采用方式互斥：同时上线会重复插入同一行。

**规则写在哪里才会生效**（patch 层按 `[bundle patches, profile patches, home patches,
overlays]` 合并，后应用者整块替换同一行的 `config`）：

| 载体                                                                          | 生效范围                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<name>/cordis.patch.yml`） | dev 与打包形态都生效，但只属于本机 home               |
| app 的 `cordis.patch.yml`                                                     | 打包（`bundle`）形态：作为 seed 的 profile patch 生效 |
| 一个自有 bundle 的 patch                                                      | 所有形态（随包分发）                                  |

本部署采用最后一种：**装配与规则在 `@morlay/dsh-preset` 的 bundle patch 里一起维护**
（禁用官方两行 + 插入本包行 + `access` 规则，跨 dev / 打包形态一致），不依赖 app 的
`dsh.profile.bundles` 再列一层。

## 前提

- 官方 `sandbox` 与 `fs-sandbox` 行必须禁用：同一 scope 内重复注册同名服务会 fail loud
  （`service "sandbox" has been registered at …`），而不是覆盖。
- 启用规则的层必须同时做三件事——禁用官方两行、插入本包行、写规则：只做后两件时官方
  实现仍在提供 `ctx.sandbox` / `ctx.fs`，规则没有生效点，沙箱静默退回「只有工作区 +
  `/tmp` 可写」（命令照常跑，没有报错）。装配守卫见 `@morlay/dsh-preset` 的
  `patch.spec.ts`。
- 规则与 `runnerCommand` 互斥：自定义 runner 的 argv 方言无法识别，此时配了规则会在
  `confine` 抛错（宁可失败也不让规则静默失效）。
- `read-only` 模式不追加 `rw` 条目（显式选定的只读边界不因额外可写根放松），但 `r-`
  与 `--` 条目仍然生效。

## 已知限制

- **Linux / Windows 的子进程侧降级**：bwrap 把 `r-` 与 `--` 都表达成只读挂载
  （`--ro-bind-try`，所以 `--` 在 bwrap 上退化为「只拒写入」），Landlock 无法表达任何
  子路径规则，Windows ACL runner 的 argv 没有承载额外 grant 的入口（`rw` 同样不生效）。
  加载期对每种降级都打 warn，`ctx.fs` 侧（read / write / edit 工具）在所有平台保持完整
  语义。
- **bwrap 参数顺序未实测**：`--bind-try` / `--ro-bind-try` 的「后挂载覆盖先挂载」与
  `-try` 缺路径语义来自 bwrap 文档而非本仓库的测试证据（本机为 macOS）。
- **`r-` / `--` 条目不隐藏目录项**：`ls` 仍能看到被保护文件的名字，被拦的是内容读取
  （仅 `--`）与写入。
- **`ctx.fs` 侧是策略检查，不是内核边界**：与它替换掉的官方 `fs-sandbox` 同一威胁模型
  （受信代码 + 模型可控路径）；内核级隔离仍是 `ctx.sandbox` 的职责。
- **Windows 额外授权未实现**：官方 `AclWriteGrant` 可以做预授权，但没有把 `AclWriteGrant`
  接进 `confine` 的现成路径，本版只告警。

## 本地开发

根目录 `just test`（vitest，含 `seatbelt.e2e.spec.ts`——非 macOS 或被更外层 Seatbelt
拦住时自动跳过）、`just lint`（oxlint typeAware）、`just build`（tsdown 构建本包）。
