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

| 环节                             | 做什么                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `system-prompt/assemble`（瀑布） | 保留 `keep` 名单内的 section；其余非空 section 从 assembly 移除，并按 order 捕获文本        |
| `agent/pre-step`                 | 会话 surface 上没有本轮文本的 reminder 时，注入一条 user 消息，位置紧随已领取的这批消息之后 |
| `agent/request-error`（重试）    | 压缩把早期 reminder 换进摘要 checkpoint 后，重试请求不再经过 pre-step：把 reminder 补回落库 |

- **信封**：`<system-reminder>`，与工作区指令同一约定。首行声明系统提示词是刻意
  精简的、下面的内容仍属系统级规则、最新一条覆盖更早的 reminder。
- **首步一次 + 变化增量**：surface 上有相同文本就不重复注入；`plan:policy`、
  `tools:ptc-only`、`tools:sdk` 这类按模式渲染的 section 变化时追加一条新的**全量**
  reminder（靠首行的覆盖声明消歧，不试图只发差量）。
- **幂等只认会话 surface**：最近一条本插件消息的文本相同就不再注入——稳态、重启 /
  恢复、以及 rewind（retry / 编辑 / 撤回）截断掉旧 reminder 后都走同一条判定，
  截断即补发；不进程内记账，回退不会留下"以为送过"的黑洞。
- **压缩后的首次请求**：reminder 是会话早期的 user 消息，压缩会把它换进摘要
  checkpoint。上下文溢出触发的压缩发生在 `agent/request-error` 内，其重试请求由
  surface 历史重建、**不再经过 pre-step**——插件以 `prepend` 站在该瀑布最外层
  （压缩在 retry 分支短路、不调 `next()`）等它完成后，按同一 surface 判定补写一条。
  压力压缩（pre-step 内）不需要它：下一 step 的 pre-step 判到 surface 上已无
  reminder，照常注入。判定与其余路径共用，所以每个请求里最多一条 reminder：
  一次压缩补一次，压缩之间的轮次不再重复，未触发压缩的 retry（如 provider 抖动）
  也不补。
- **转义**：正文里的 `</system-reminder>` 写成 `<\/system-reminder>`，避免提前闭合信封。

## 配置

| 字段   | 默认                                                         | 含义                                                       |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `keep` | `['deployment:persona-prefix', 'deployment:persona-suffix']` | 留在系统提示词里的 section 名；其余（非空）降级为 reminder |

`keep` 按 **section 名**匹配，所以子 agent 在 agent scope 注册的同名 persona 也
自动留在系统提示词里。

## 装配

作为 **host plane** 的部署级行装配一次：本部署在 `@morlay/dsh-preset` 的
`cordis.patch.yml` 里插入这一行（一行覆盖全部 preset，preset composition 不各自带它；
patch 里行内容与依赖解析要求见
[dsh-preset 的 README](../dsh-preset/README.md)）。

放在 host plane 而不是 preset composition：这是一条与具体 preset 无关的部署级
策略；注册在 root scope 的 listener 会收到每个 agent 的装配与 pre-step 事件——理由见
[设计 预设生成与装配](../dsh-preset/.agents/designs/20260917-预设生成与装配.md)。

## 前提

- 系统提示词由部署级 `system-prompt` 的 `personaPrefix` / `personaSuffix` 提供，
  只在 `@morlay/dsh-preset` 的 `cordis.patch.yml` 维护一份；`keep` 与之一致。
- 裁剪与降级由同一份 `keep` 名单决定，不存在"系统提示词删了、reminder 没送"的
  偏差。上游 `persona` 行的 `complete: true` 也能把系统提示词收到只剩 persona，
  但它同时丢弃 suffix，且子 agent 注册 persona 时 `complete` 标记消失——本插件
  不做这种依赖顺序的事。
- 本插件在稳态只走 pre-step 的消息通道（模型可见即可重建，落库由 loop 负责）；唯一
  例外是压缩后的重试请求——它不经过 pre-step，插件直接 `append` 一条 reminder，落库
  后重放与首次注入路径一致。

## 已知限制

- **reminder 仍是模型输入**：总 token 不减，只是不再占系统提示词的位置；要真正
  省 token 得把内容一起删掉。
- **稳态每步扫一次 surface**：注入判定倒序读 surface 节点，命中即停；会话很长又
  从未注入过（例如插件启用前的旧会话）时首次扫描走满，属可接受成本。
- **顺序**：reminder 与工作区指令（`AGENTS.md`）都是 pre-step 注入的 user 消息，
  两者先后由 listener 注册顺序决定，语义上互不依赖。
- **压缩后重试请求的 reminder 位置**：它由 `agent/request-error` 补写在 history 末尾
  （in-history 系统提示词之后），不紧随本轮用户消息——压缩已经改写了那段历史顺序。
