# @morlay/dsh-instructions-as-prompt

把工作区 `AGENTS.md` 指令挂载为 **system-prompt section**，而不是上游默认的
user 角色消息。

## 为什么需要它

上游 `dsh-agent-instructions` 把指令作为 **user 消息**注入（挂 `agent/pre-step`
waterfall，插在用户输入之后）。实测最终请求：

```
role=system   "You are an AI agent powered by DeepSeek Harness.…"   ← system prompt
role=user     "你好"                                                  ← 用户输入
role=user     "<system-reminder>…workspace instructions…"           ← AGENTS.md
role=user     "<system-reminder>…skill catalog…"
```

也就是说 AGENTS.md 与 system prompt 是**两条独立通道**。本插件提供另一种装配：
让它在系统提示词内部，与 persona 同级。

## 装配

本包自带 `cordis.patch.yml` 并声明 `dsh.bundle`，因此可**作为独立 bundle 安装**：

```jsonc
// profile 的 package.json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@morlay/dsh-instructions-as-prompt"] } }
```

也可在别的 bundle 里按 id 插入（`cordis.patch.yml` 的等价写法）：

```yaml
- insert:
    - id: instructions-as-prompt
      name: "@morlay/dsh-instructions-as-prompt"
      config:
        maxBytes: 65536
```

### 与上游 `agent-instructions` 并存

**两者可同时挂载，不必 disable 任何一个。** 各司其职：

|               | 上游 `agent-instructions`      | 本插件                        |
| ------------- | ------------------------------ | ----------------------------- |
| baseline 落点 | user 消息                      | system prompt section（冻结） |
| 变更提醒      | 负责（digest 检测 + reminder） | **不负责**                    |

职责严格分工：本插件只做「把 baseline 一次性放进 system prompt」，**变更通道完全
交给上游**——上游的增量检测、`<system-reminder>` 渲染与投递时机都已完备，重复
实现只会引入不一致。因此同时挂载时同一份指令会出现两次（system prompt 里的稳定
前缀 + user 消息里的增量更新），这是刻意分工而非重复注入。

配置字段沿用上游 `dsh-agent-instructions` 的发现与预算语义：

| 字段                             | 默认                    | 含义                      |
| -------------------------------- | ----------------------- | ------------------------- |
| `maxBytes`                       | 必填                    | 一次渲染的 UTF-8 字节上限 |
| `dshHome`                        | `$DSH_HOME` 或 `~/.dsh` | 用户全局 `AGENTS.md` 所在 |
| `projectRootMarkers`             | `[".git"]`              | 向上寻找项目根的目录标记  |
| `maxSourceBytes`                 | 上游默认                | 单文件读取上限            |
| `instructionFileCandidates`      | `["AGENTS.md"]`         | 同目录基础候选            |
| `localInstructionFileCandidates` | `["AGENTS.local.md"]`   | 同目录 local overlay      |

## 冻结语义

system prompt 是会话 surface 的 node 0，其内容变化会替换该节点并触发
`startsSeries`，使 provider 侧的 KV cache 失效。所以本插件的 section **只注入
一次并冻结**：即使文件后来变了，section 文本也不动，前缀缓存保持稳定。

文件变更由上游 `agent-instructions` 作为 user 消息投递 `<system-reminder>`，位置
在对话尾部，不影响前缀缓存。本插件不参与这条通道。

### 冻结值随 system prompt 节点持久化

`preStep` 每次请求都重新 `assemble()`，resume 后进程内缓存为空。若此时重读文件，
system prompt 会变成**当前**内容而非历史内容——既违反仓库的
model-visible ⟺ logged 规则，也会让 surface node 0 被替换、打断 KV cache。

因此注入文本被包在标记里：

```
<!-- workspace-instructions:begin -->
…指令正文…
<!-- workspace-instructions:end -->
```

标记随 system prompt 的 `system/message` 节点一起持久化，之后从**存活的
system/message 节点**（与上游 `SystemPromptProjection` 同一读法）提取正文即可重建
冻结值。重建时会重新包上标记，保证渲染结果与首次逐字相同。

**为什么不用自定义日志事件**：上游 `Session.append()` 不写 `ignorable` 标记，而
持久化读路径会拒绝未知事件类型——会报
`contains event type "…" unknown to this harness and not marked ignorable`。
复用 system prompt 节点则完全避开这个问题，也不引入任何新事件类型。

标记用 HTML 注释而非 XML 标签：这段文本同时是模型可见内容，标记需低调且不易与
指令正文冲突。

## 实现要点

**挂载点是 `system-prompt/assemble` waterfall，不是 `ctx.systemPrompt.section()`。**
section 的 `text` provider 是**同步**的（`(context) => string`），而文件加载是
**异步**的（读盘 / 经 `ctx.fs` provider）。`assemble` 是唯一的异步装配点，且其
返回值权威——可以在其中插入 section。

**插入位置按锚点而非 order 数值。** `assembly.sections` 已由装配器按 order 排好
序；上游只导出 persona 两个 section 名常量，而 `getSectionOrder()` 需要
`SystemPrompt` 实例（waterfall 里拿不到）。所以本插件锚在
`deployment:persona-prefix` 之后插入，既不复制一份 order 表跟着上游 drift，也表达
了「项目指令比 persona 具体、早于工具指引」的意图。实测结果：

```
harness:identity             ← 上游
deployment:persona-prefix    ← 部署 persona
workspace:instructions       ← AGENTS.md（本插件）
deployment:persona-suffix
```

**去掉 `<system-reminder>` 信封。** 上游把该框架烘焙进内容（session surface 逐字
投影、不再包裹），那是 user 消息的呈现约定；进入系统提示词后不需要这层信封，
故 `unwrapReminder` 只取正文。

**文件发现与预算完全复用上游。** `loadBaselineInstructions` 负责用户全局 + 项目链
发现、内容去重、字节预算（超预算先丢宽范围文件、保最具体的，最具体的二分截断）。
本插件不重复实现。

**依赖 `fs` provider。** 上游的发现/读取走 `ctx.fs`（无 provider 时它返回空，
不是回退到 host 读盘）。base bundle 已带 `fs-local`，故本包 patch 不再声明它。

**依赖声明**：`inject = ["sessionProjections", "systemPrompt"]`。用
`ctx.plugin({ name, apply })` 这种匿名对象挂载会丢掉 `inject` 声明（cordis 从
模块命名空间读取），必须以 `ctx.plugin(import * as plugin)` 或真实包名挂载。

## 与上游不变量的关系

本插件**不**触碰请求级 `system` 字段。上游 `dsh-agent-loop/invariant` 强制
`options.system === undefined` 且 `messages` 等于 `session.deriveMessages()`——
系统提示词走 surface node 0 这条持久路径，从而保证任何历史请求都能从会话日志
精确重建。本插件走的正是这条路径（section → `renderPrompt` → surface node），
所以不变量保持成立。

## 取舍

- **section 内容不随后续变更更新**：这是刻意的——变更会替换 surface node 0、打断
  KV cache。变更靠上游 reminder 告知模型，system prompt 里的那份保持首次内容。
- **与上游内容可能短暂不一致**：上游 reminder 是增量投递的，模型读到的最新指令在
  对话尾部；system prompt 里是首次快照。两者语义不冲突（都说明"更具体的优先"），
  但严格比对时会看到差异。
- **`complete` section 冲突**：若某 preset 注册了 `complete: true` 的 section
  （如上游 `minimal` preset 的 persona），装配器只保留那一个 section，本插件的
  注入会被丢弃——这是上游语义，插件不做对抗。
- **pi-ai 与 deepseek 的差异**：`llm-deepseek` 声明
  `systemPromptUpdate: 'in-history'`，system prompt 变化时**追加**新节点；
  `llm-pi-ai` 未声明，走**替换**语义。本插件冻结 section，故两者差异只影响别的
  插件对 system prompt 的改动。

## 维护注意

- `agent-instructions` 若在上游改名或改导出，`loadBaselineInstructions` 的导入会
  在编译期失败（`@deepseek-ai/dsh-agent-instructions` 是 dependencies，不是 peer）。
- 上游 `SECTION_ORDERS` 调整不影响本插件——它按位置锚定，不依赖数值。
