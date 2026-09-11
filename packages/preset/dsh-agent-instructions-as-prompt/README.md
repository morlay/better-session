# @morlay/dsh-agent-instructions-as-prompt

上游 `@deepseek-ai/dsh-agent-instructions` 的 fork：源码复制（`src/` 下 6 个文件
与上游一一对应），**baseline 的落点从 user 消息改成 system-prompt section**，
其余行为（发现、去重、字节预算、工具触达后的增量提醒、pre-step 折叠）与上游一致。

## 行为

| 项            | 上游                                     | 本包                                                     |
| ------------- | ---------------------------------------- | -------------------------------------------------------- |
| baseline 落点 | user 消息（`<system-reminder>` 信封）    | system prompt section，追加在**全部 section 之后**       |
| 注入范围      | 全局 + 项目链 + 子目录，一次渲染         | **只注入用户全局与项目根的指令文件**，每文件一个 section |
| 正文          | intro 文案 + `Instructions from:` 标题   | **文件内容原样**（标记行之外不加任何包裹）               |
| 首次注入      | 每轮 pre-step 检查并按需注入             | 首次装配注入，之后从 system prompt 标记重建（内容冻结）  |
| 中途变更提醒  | 工具触达 / 文件变更 → user 消息 reminder | **相同**（未改动，嵌套目录的指令由此送达）               |
| 发现与预算    | —                                        | 相同（复用上游 `files.ts` / `render.ts`）                |

因此上游那一行必须禁用（见「装配」），否则同一份指令会在 user 消息里再出现一次。

## 装配

本包自带 `cordis.patch.yml`（`dsh.bundle.patch` 声明），作为独立 bundle 安装时
自动禁用上游行并挂载本包：

```jsonc
// profile 的 package.json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@morlay/dsh-agent-instructions-as-prompt"]
  }
}
```

在别的 bundle 里按 id 装配（等价写法）：

```yaml
- id: agent-instructions
  disabled: true

- insert:
    - id: agent-instructions-as-prompt
      name: "@morlay/dsh-agent-instructions-as-prompt"
      config:
        maxBytes: 65536
```

配置字段与上游同名同义（`maxBytes` 必填；`dshHome`、`projectRootMarkers`、
`maxSourceBytes`、`instructionFileCandidates`、`localInstructionFileCandidates`
缺省即上游默认，例如默认候选含 `CLAUDE.md`）。

**preset 里也要替换**：preset 的 `agent.cordis.yml` 是**会话级** composition，
profile 级的 `disabled` 管不到它——只要 preset 里还写着上游包名，每个会话仍会由
上游插件把 baseline 作为 user 消息注入一次。`@morlay/dsh-preset` 的生成器
（`tool/generate-presets.ts`）因此在生成产物时把 `agent-instructions` 行的 `name`
换成 `@morlay/dsh-agent-instructions-as-prompt`。

`fs` provider 是必需的（发现/读取经 `ctx.fs`，无 provider 时插件是 no-op）；
base bundle 已带 `fs-local`。

## 正文与快照

section 正文就是文件内容：没有 `<system-reminder>` 信封、intro 文案或
`Instructions from:` 标题，**也没有任何元数据行**——那些都是 user 消息的呈现约定。
正文里的 `{{` 会被插入一个零宽字符：`renderPrompt` 对 `{{name}}` 做严格插值，未注册
的名字会直接抛错，指令正文里的模板片段不该让整轮请求失败。

注入过什么由**两份快照**记住，都不进模型可见文本：

| 快照   | 位置                                                                         | 作用                                                                         |
| ------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 进程内 | `promptBaselines`（WeakMap，按 session）                                     | 本轮装配复用，文件改了也不动 system prompt                                   |
| 持久   | `ctx.storageDomain` 的 `agent_instructions_as_prompt` 域（按 session id 键） | 重启 / resume 后重建同样的 section，并让增量协调继续看得见 baseline 的 scope |

于是：**渲染结果与上次逐字相同** → `SystemPromptProjection` 判定无变化 → 不替换
surface node 0、不打断 KV cache 前缀；文件在会话关闭期间被改过也不影响，变更照旧由
user 消息提醒送达。

**为什么不用会话事件**：上游 `Session.append()` 不写 `ignorable` 标记，而持久化读路径
会拒绝未识别的事件类型——外部插件写不了（也无法注册）这种类型，一条自定义事件会让
整条会话在重启后读不回来。

**为什么不用会话投影**：投影状态必须由 `apply(state, event)` 从会话事件 fold 出来，
且上游明确「缓存行永不权威，只是 fold 快捷方式」；没有承载数据的事件，投影恢复不出
快照。`storage-domain` 正是为这类 host 侧状态准备的（其文档把 session sidecar
metadata 列为首选用途），且写入在 resolve 前已落盘。

## 实现要点

- **挂载点是 `system-prompt/assemble` waterfall**：section 的 `text` provider 是同步
  的，而文件加载是异步的；`assemble` 是唯一的异步装配点，且其返回值权威。
- **`inject = ["sessionProjections"]`**：增量协调所需的 `turnBoundary` 投影。
  `systemPrompt` 刻意不声明——注入是事件监听器，而本插件也会挂在 preset 的会话级
  composition 里，对 host 级服务做严格注入会让整个插件（含增量协调）加载不上。
- **注入幂等**：assembly 里已有本插件的 section 就让位，profile 级与 preset 级各挂
  一个实例时不会重复注入。
- **存储域可选**：首次装配时经 `ctx.get("storageDomain")` 打开一次；未挂载或路由不到
  支持 kv 的后端时只降级为「每进程重读文件」（重启后若文件已改，system prompt 会更新
  一次），不影响注入本身。
- **本地改动集中在两处**（其余为上游源码原样）：
  - `src/index.ts`：`visibleBaselineSource` 改读会话快照；compose 不再
    把 baseline 放进 user 消息（只保留 excludedScopes / 版本记账，且只把「进
    system prompt 的那两个 scope」算作已提供）；末尾挂 `applyPromptSections`。
  - `src/state.ts`：`visibleInstructionChanges` 增加快照来源；插件名改为
    `agent-instructions-as-prompt`。
  - 新增 `src/prompt.ts`（注入范围过滤 + section 注入 + 快照）与
    `src/baseline-domain.ts`（存储域声明与打开）。

## 上游同步

升级 `DEEPSEEK_HARNESS_VERSION` 后：

1. 用上游 `packages/context/agent-instructions/src/` 覆盖本包 `src/` 的同名 6 个
   文件（`config/digest/files/render/state/index`），保留 `prompt.ts` 与
   `section-marker.ts`。
2. 重新应用上面的本地改动（文件头注释里有逐项说明）。
3. `pnpm exec vitest run packages/preset/dsh-agent-instructions-as-prompt`：测试覆盖
   section 注入范围与位置、正文即文件内容、跨进程快照重建、baseline 不重复注入、
   变更仍产出提醒。

## 已知限制

- **section 内容不随后续变更更新**：变更会替换 surface node 0、打断 KV cache；
  最新指令由 user 消息 reminder 送达对话尾部。
- **只注入全局与项目根**：嵌套目录（含 cwd 位于子目录时的中间层）的指令不进
  system prompt，只在工具触达后以 user 消息提醒——这是刻意的范围收窄。
- **文件名沿用候选配置**：位置过滤之后，项目根/全局的每个命中候选（默认含
  `CLAUDE.md`、`AGENTS.local.md`）各成一个 section；要只认 `AGENTS.md`，在 config
  里设 `instructionFileCandidates: ["AGENTS.md"]`、`localInstructionFileCandidates: []`。
- **`complete` section 冲突**：若某 preset 注册了 `complete: true` 的 section
  （如上游 `minimal` preset 的 persona），装配器只保留那一个 section，本插件的注入
  会被丢弃——这是上游语义，插件不做对抗。
- **baseline identity 变化**（cwd / 项目根标记改变）会重新加载并替换 section 文本，
  与上游的 replacement baseline 语义一致，但代价是替换 node 0。
