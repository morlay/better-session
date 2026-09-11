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

`fs` provider 是必需的（发现/读取经 `ctx.fs`，无 provider 时插件是 no-op）；
base bundle 已带 `fs-local`。

## section 标记

每个 section 的首行是一条 JSON 注释，携带重建与增量对比所需的元数据：

```
<!-- workspace-instructions {"identity":"…","scope":".\u0000AGENTS.md","path":"AGENTS.md","digest":"…"} -->
…文件内容原样…
```

正文就是文件内容：没有 `<system-reminder>` 信封、intro 文案或 `Instructions from:`
标题——那些是 user 消息的呈现约定。标记行是唯一的附加内容。

标记随 system prompt 的 `system/message` 节点一起持久化（surface node 0），因此：

- **resume / fork 后重建冻结文本**：从存活的 `system/message` 节点解析标记，
  不重读文件——渲染结果与上次逐字相同，`SystemPromptProjection` 判定无变化，
  不替换 node 0、不打断 KV cache。
- **增量协调看得见 baseline**：`visibleInstructionChanges` 从标记重建 baseline 的
  scope 状态，后续 pre-step 因此不会把 baseline 当成新变更重复注入；文件真的变了
  仍会产出 user 消息提醒。

标记用 HTML 注释而非 XML 标签：它同时是模型可见文本，需低调且不易与正文冲突。
正文里的 `{{` 会被插入一个零宽字符——`renderPrompt` 对 `{{name}}` 做严格插值，
未注册的名字会直接抛错，指令正文里的模板片段不该让整轮请求失败。

**为什么不用自定义日志事件**：上游 `Session.append()` 不写 `ignorable` 标记，持久化
读路径会拒绝未知事件类型（`unknown to this harness and not marked ignorable`）。
复用 system prompt 节点则完全避开这个问题。

## 实现要点

- **挂载点是 `system-prompt/assemble` waterfall**：section 的 `text` provider 是同步
  的，而文件加载是异步的；`assemble` 是唯一的异步装配点，且其返回值权威。
- **`inject = ["sessionProjections", "systemPrompt"]`**：前者是上游增量协调所需
  （`turnBoundary` 投影），后者是本包的注入点。
- **本地改动集中在两处**（其余为上游源码原样）：
  - `src/index.ts`：`visibleBaselineSource` 改读 system prompt 标记；compose 不再
    把 baseline 放进 user 消息（只保留 excludedScopes / 版本记账，且只把「进
    system prompt 的那两个 scope」算作已提供）；末尾挂 `applyPromptSections`。
  - `src/state.ts`：`visibleInstructionChanges` 增加标记来源；插件名改为
    `agent-instructions-as-prompt`。
  - 新增 `src/prompt.ts`（注入范围过滤 + section 注入）与 `src/section-marker.ts`
    （标记编解码）。

## 上游同步

升级 `DEEPSEEK_HARNESS_VERSION` 后：

1. 用上游 `packages/context/agent-instructions/src/` 覆盖本包 `src/` 的同名 6 个
   文件（`config/digest/files/render/state/index`），保留 `prompt.ts` 与
   `section-marker.ts`。
2. 重新应用上面的本地改动（文件头注释里有逐项说明）。
3. `pnpm exec vitest run packages/preset/dsh-agent-instructions-as-prompt`：测试覆盖
   section 注入范围与位置、正文即文件内容、冻结重建、baseline 不重复注入、变更仍
   产出提醒。

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
