# @morlay/dsh-prompt-reminder

把系统提示词里被裁掉的 section 降级为 `<system-reminder>` user 消息的 cordis
插件：系统提示词只留部署级 persona（`personaPrefix` / `personaSuffix`），工具
说明、Agent Teams 规则、plan 规则、PTC SDK 文档等在每轮请求前随用户消息送达。

## 为什么

上游把每个工具的跨调用说明（`tool:bash`、`tool:read`、`tool:glob`、…）、Agent
Teams 协作规则、harness 源码位置、Web GUI 说明都注册成系统提示词的 section。
它们条数多、篇幅大（本部署实测 9200 字符里约 7400），挤在上下文最前面稀释
真正要遵守的少量纪律。本插件把这些 section 从系统提示词移到紧随用户消息之后
的 reminder：内容一字不少，注意力分层干净；系统提示词也不再随 plan / PTC 模式
切换而变动。

## 行为

| 环节                             | 做什么                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `system-prompt/assemble`（瀑布） | 保留 `keep` 名单内的 section；其余非空 section 从 assembly 移除，并按 order 捕获文本 |
| `agent/pre-step`                 | 本轮文本与上一次送达的不同时，注入一条 user 消息，位置紧随已领取的这批消息之后       |

- **信封**：`<system-reminder>`，与工作区指令同一约定。首行声明系统提示词是刻意
  精简的、下面的内容仍属系统级规则、最新一条覆盖更早的 reminder。
- **首步一次 + 变化增量**：文本不变时不重复注入；`plan:policy`、`tools:ptc-only`、
  `tools:sdk` 这类按模式渲染的 section 变化时追加一条新的**全量** reminder
  （靠首行的覆盖声明消歧，不试图只发差量）。
- **幂等**：进程内按 agent 记最近送达文本；重启 / 恢复时扫会话 surface 上最近一条
  本插件消息，文本相同就不再注入。
- **转义**：正文里的 `</system-reminder>` 写成 `<\/system-reminder>`，避免提前闭合信封。

## 配置

| 字段   | 默认                                                         | 含义                                                       |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `keep` | `['deployment:persona-prefix', 'deployment:persona-suffix']` | 留在系统提示词里的 section 名；其余（非空）降级为 reminder |

`keep` 按 **section 名**匹配，所以子 agent 在 agent scope 注册的同名 persona 也
自动留在系统提示词里。

## 装配

作为 **host plane** 的部署级行，在 profile 的 bundle patch 里定义一次即可：

```yaml
- insert:
    - id: prompt-reminder
      name: "@morlay/dsh-prompt-reminder"
```

`@morlay/dsh-preset` 的 `cordis.patch.yml` 就是这么声明的：一次覆盖全部 preset
（standard / ptc 以及后续新增的），preset composition 不各自带这一行。

profile 的依赖树必须能解析该包名（示例 app `apps/dsh-custom-next` 的
`dependencies` 已声明）——preset 的行与 host plane 的行都用 profile 的 resolver
解析，换工作区时要一并声明，否则该行加载失败、工具说明会留在系统提示词里。

放在 host plane 而不是 preset composition：这是一条与具体 preset 无关的部署级
策略；注册在 root scope 的 listener 会收到每个 agent 的装配与 pre-step 事件。

## 前提

- 系统提示词由部署级 `system-prompt` 的 `personaPrefix` / `personaSuffix` 提供，
  只在 `@morlay/dsh-preset` 的 `cordis.patch.yml` 维护一份；`keep` 与之一致。
- 裁剪与降级由同一份 `keep` 名单决定，不存在"系统提示词删了、reminder 没送"的
  偏差。上游 `persona` 行的 `complete: true` 也能把系统提示词收到只剩 persona，
  但它同时丢弃 suffix，且子 agent 注册 persona 时 `complete` 标记消失——本插件
  不做这种依赖顺序的事。
- 本插件不写会话事件，reminder 走 pre-step 的消息通道（模型可见即可重建，落库由
  loop 负责）。

## 已知限制

- **reminder 仍是模型输入**：总 token 不减，只是不再占系统提示词的位置；要真正
  省 token 得把内容一起删掉。
- **回退边缘**：rewind 掉旧 reminder 后，若当前文本与内存缓存仍相同，不会立即补
  一条（重启或下次文本变化时恢复）。
- **顺序**：reminder 与工作区指令（`AGENTS.md`）都是 pre-step 注入的 user 消息，
  两者先后由 listener 注册顺序决定，语义上互不依赖。
