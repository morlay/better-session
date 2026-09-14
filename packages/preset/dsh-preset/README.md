# @morlay/dsh-preset

个人用 dsh profile bundle。包的实体是 `cordis.patch.yml` 与构建产出的
`dist/presets/`（bundle patch 由 `dsh.bundle.patch` 声明、profile 组合器经该
字段解析）。

## 内容

| 文件                       | 作用                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `cordis.patch.yml`         | bundle patch：禁用官方 preset、注册本包 preset 为默认、声明个人 `llm-pi-ai` route、插入 `prompt-reminder` 行 |
| `tool/generate-presets.ts` | 从上游生成 preset 的模块 + tsdown hooks                                                                      |
| `dist/presets/standard/`   | 构建产物：自定义 preset「标准模式」（由上游 `standard` 生成）                                                |
| `dist/presets/ptc/`        | 构建产物：自定义 preset「PTC 模式」（由上游 `ptc` 生成）                                                     |

`cordis.patch.yml` 里插入的 `prompt-reminder`（`@morlay/dsh-prompt-reminder`）把被
裁掉的系统提示词 section 降级为 `<system-reminder>` user 消息，见「工具说明降级为
reminder」。

## 禁用官方 preset

patch 设 `includeShippedRoot: false`，官方 `minimal` / `cordis` 等不再出现在
roster；本包 `dist/presets/` 作为唯一 root 提供 `standard` / `ptc`（`default:
standard`）。`includeShippedRoot` 是上游 `dsh-agent-presets` 的正式配置项，
不是 hack。

### 为什么 id 沿用官方名

产物目录名 = 上游 preset id。`presetDisplayText` 对 `trust: system` 且 id 命中
`BUILT_IN_PRESET_KEYS` 的行走客户端语言字典，因此展示名自动本地化（zh「标准模式」
/ en「Standard mode」），`preset.yml` 的 `name` / `description` 会被字典遮蔽。
`preset.yml` 仍有意义：`order` 决定 roster 排序，`name` / `description` 作为
字典未覆盖 locale 的兜底。

## persona 走部署级 system-prompt，preset 不碰

个人提示词只在 `cordis.patch.yml` 的 `system-prompt` 行维护一份：

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: false # 关掉 harness identity
    includeRuntimeContext: false # 关掉 runtime context 快照
    personaSuffix: Your working directory is {{cwd}}.
    personaPrefix: |- # 个人提示词
      …
```

preset 自带的 `persona` 行会在 agent scope 注册 `deployment:persona-prefix` 并
**按 scope 遮蔽**部署级值（上游 `packages/core/system-prompt/tests/scoped.spec.ts`
固化了该语义），所以生成器把那一行**删掉**，而不是复制一份改过的 persona——同一份
文案只维护一处。

### 指令遵循设计

`personaPrefix` 位于 order 0（prompt 最前，紧跟被关掉的 harness identity 之后）：
声明指令优先级（直接用户指令 > 工作区 `AGENTS.md` > 本系统提示词）与执行协议。其中
点名 `AGENTS.md` 是**强制约束**——官方 `agent-instructions` 注入模板的措辞
（"may be relevant" / "as guidance" / "do not override…"）是上游的通用保守表述，会让
模型把仓库规则当参考而不是规则，所以这里显式反制。协议一行覆盖：动手前读相关
`AGENTS.md`、过程自检、交付前核对红线与验证证据、无法遵守时明确说明、派发子代理时
把约束写进任务说明。

`personaSuffix` 位于 order 10200（prompt 最后）：一句话复述"结束任务前对照本提示词与
`AGENTS.md` 自检"。长 prompt 里中段指令会被稀释，首尾各放一次最关键的约束，用近因
位置兜住遵循度；细节只在 prefix 维护，避免两处重复。

改这两段后**必须重启 dsh 才能生效**：profile 在进程启动时装载，`system-prompt` 的
section 在插件构造时注册；dev 模式重启 `just custom dev`/`just custom desktop`，打包
形态需重新 `just custom bundle`（patch 随 seed 快照复制）。

自建 preset 仍然必要，但只为别的事：`includeShippedRoot: false` 之后需要一份自己的
roster（id 沿用官方名以走客户端语言字典），以及桌面形态下 preset 必须落在 dsh 包的
`config/agent-presets` 挂载点（见 dsh-desktopify 的 `dsh.desktop.agentPresets`）。

## 工具说明降级为 reminder，不进系统提示词

上游把每个工具的跨调用说明（`tool:bash`、`tool:read`、…）、Agent Teams 协作规则、
harness 源码位置、Web GUI 说明都注册成系统提示词的 section。本部署实测它们占
9200 字符里的约 7400：条数多、篇幅大、挤在上下文最前面，稀释真正要遵守的那几行
纪律。`cordis.patch.yml` 因此在 host plane 插一行：

```yaml
- insert:
    - id: prompt-reminder
      name: "@morlay/dsh-prompt-reminder"
```

一处定义覆盖全部 preset（standard / ptc 以及后续新增的）——这是与具体 preset 无关
的部署级策略，preset composition 不各自带这一行，生成器也就不必碰它。该插件注册
在 root scope，会收到每个 agent 的装配与 pre-step 事件（含子 agent）：

- 装配（`system-prompt/assemble` 瀑布）时保留 `keep` 名单——默认是部署级
  `deployment:persona-prefix` / `deployment:persona-suffix`——内的 section，其余
  非空 section 从 assembly 移除并按 order 捕获文本；
- pre-step 时把捕获的文本作为一条 `<system-reminder>` user 消息注入，紧随本轮
  用户消息之后；文本不变不重复注入，`plan:policy` / `tools:ptc-only` 这类按模式
  渲染的 section 变化时追加一条新的全量 reminder（首行声明最新一条覆盖更早的）。

于是系统提示词只剩首尾两段个人提示词，其余内容仍在上下文里、但不再占系统提示词
的位置，也不再随模式切换改动。**为什么不用 `persona` 行的 `complete: true`**：那会
连 suffix 一起丢，且子 agent 自己注册同名 persona 时 `complete` 语义消失，保留 /
降级会不一致；本插件按 `keep` 名单匹配 section 名，两种 agent 行为一致。完整行为与
配置见 `packages/preset/dsh-prompt-reminder/README.md`。

## 工作区指令走官方行为，候选收紧为 AGENTS 系列

preset 里的 `agent-instructions` 行是官方 `@deepseek-ai/dsh-agent-instructions`：
baseline 按官方语义作为 user 消息注入一次。生成器只覆盖该行 config 的两个字段：

```yaml
instructionFileCandidates: ["AGENTS.md"] # 上游默认 ['AGENTS.md','CLAUDE.md']
localInstructionFileCandidates: ["AGENTS.local.md"] # 上游默认还含 CLAUDE.local.md
```

即**不读 CLAUDE 系列**（本部署不需要 CLAUDE 兼容）；`maxBytes` 等其余字段跟随上游。

本仓库曾有一个把 baseline 落点改成 system-prompt section 的 fork
（`@morlay/dsh-agent-instructions-as-prompt`），一直未接入默认打包；提示词分层定为
「系统提示词只留 persona、其余走 reminder」之后它已删除——baseline 留在 user 消息
通道与这个分层一致。

## preset 由构建生成，不是手工副本

产物落在 `dist/`，由 tsdown 的 `build:done` hook 在每次 `pnpm build` 时生成
（`tsdown.config.ts` 挂 `presetHooks()`）。放 dist 而非源码树：dist 是 gitignore
的构建输出，既不与 oxfmt 互相改格式，也不把派生文件混进源码。

必须挂 `build:done` 而非 `build:prepare`——tsdown 时序是
`build:prepare` → `clean()`（清空 outDir）→ rolldown → `build:done`，写在 clean
之前会被删掉。

单独重生成（默认输出 `dist/presets`，可传目录）：

```sh
pnpm --filter @morlay/dsh-preset run generate-presets [outDir]
```

脚本把上游 composition 当**数据**读入：`js-yaml` 用 include 的
`entryListSchema` 解析（`!!js` 标签保留为表达式节点）→ 在 JS 里改三处（删掉
`persona` 行、把 `agent-instructions` 行的候选收紧为 AGENTS 系列、插入
`prompt-reminder` 行）→ `dump` 回 YAML。因此上游任何结构性改动（新增 / 重命名
row、改字段）都自动跟随，不依赖易碎的文本锚点；上游若删掉 `persona` 行，目标
（preset 不自带 persona）本就达成，脚本照常通过。

脚本先**整目录清空**输出目录再生成：产物完全派生自脚本，残留目录（改过
`source`、旧命名）不该留下——否则 discovery 会把它们当有效 preset 扫出来。
`src/__tests__/generated-presets.spec.ts` 把产物与**现算的**期望值比较（生成到
临时目录，不依赖 build 是否跑过），并断言输出目录里没有脚本之外的目录。

代价：`dump` 不保留注释（上游 composition 的说明注释会丢）。

### 上游升级流程

1. 升级 `DEEPSEEK_HARNESS_VERSION` 并 sync/patch/build。
2. `pnpm --filter @morlay/dsh-preset run build`（build:done 会重新生成）
3. `pnpm exec vitest run packages/preset` 确认无 drift（含 reminder 插件的行为测试）。

## 装配

`agent-presets.roots` 需指向本包的 `dist/presets/`。因为该目录随包分发，
位置只能在运行期解析，故用 `!!js` 表达式从 profile 的 `baseUrl` 起
`createRequire` 解析包路径（`ctx.baseUrl` 即 root include 所在目录 = profile 根）：

```yaml
- id: agent-presets
  config:
    default: standard
    includeShippedRoot: false
    roots:
      - path: !!js process.getBuiltinModule('node:path').join(
          process.getBuiltinModule('node:path').dirname(
          process.getBuiltinModule('node:module').createRequire(ctx.baseUrl)
          .resolve('@morlay/dsh-preset/package.json')),
          'dist/presets')
        trust: system
```

用 `process.getBuiltinModule` 而非裸 `require` / `import`：求值环境是
`with (ctx) { eval(expr) }`，只有全局对象稳定可用。表达式含 `'` 与换行，
`--dump-config` 会把它输出成 folded scalar，往返后语义不变（已实测）。

`trust: system` 与 shipped root 同级：preset 是一份完整 composition，授予的
能力等价于 shell 访问，只应来自受控的安装包。

### 桌面形态

桌面宿主把 `agent-presets.roots` 固定为 dsh 包内的
`node_modules/@deepseek-ai/dsh/config/agent-presets`（`system` root），上面的
`!!js` roots 在桌面 profile 里会被覆盖，preset 列表因此为空。app 工作区改用
`dsh.desktop.agentPresets` 声明本包的 `dist/presets`，由
[dsh-desktopify](../../desktop/dsh-desktopify/README.md) 在 dev 项目与种子
profile 里把内容物化到该挂载点；`includeShippedRoot: false` 两种形态共用。

## 维护注意

- `package.json` 的 `files` 必须含 `dist`（preset 在其中）与 `tool`，否则发布产物缺内容。
- `cordis.patch.yml` 插入的 `@morlay/dsh-prompt-reminder` 必须能被 **profile** 的依赖
  树解析：示例 app 已在 `dependencies` 声明；换工作区时要一并声明，否则该行加载失败、
  工具说明会留在系统提示词里。
- 生成器显式设 `quotingType: '"'`：`yaml.dump` 默认单引号而仓库 oxfmt 偏好双引号，
  不指定会让生成器与 formatter 来回改；产物在 gitignore 的 dist 里，本就不参与 fmt。
- **dev 模式需要先构建**：`just dev` / `just desktop` / `just bundle` 都先跑
  `preset-build`（`pnpm --filter @morlay/dsh-preset run build`）。dist/presets 只在
  build 时生成，源码树里没有，新克隆下直接起 profile 会找不到 preset。
