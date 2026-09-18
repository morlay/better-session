# @morlay/dsh-reference-injection

把用户消息里的 skill 引用在 `agent/pre-step` 边界展开成 `<skill_content>` 注入消息：引用由 client 面同一份
统一解析（`@morlay/dsh-client-ui-primitives` 的 `findReferences`）认领，消息文本本身不动。

## 行为

- 只扫描本步 claimed 的 `source.kind === 'user'` 消息（外部文本伪造不了这个手势）；
- 认领所有引用形态：`skill:name`、`@skill:name`、`[label](skill:name)`、`@[label](skill:name)`；
  手写的 inline code（`` `skill:name` ``）由 `parseReferenceToken` 再兜一次；
  代码块内的同形文本不会命中（解析器保证）；
- 名字不在 skill 注册表里、或该 skill 不允许用户调用时保持普通文本；
- 去重按首次出现顺序；每个名字注入一条 instructions 形态的消息，追加在本步已有注入之后。

## 装配

部署侧（preset / profile bundle）插入一行即可；本部署的装配在 `@morlay/dsh-preset` 的 bundle patch 里
（`packages/preset/dsh-preset/cordis.patch.yml`）。

## 范围

只处理 `protocol === 'skill'` 的引用；文件引用的解析与渲染不在本插件，判定见
[ADR-引用的统一解析与渲染转换](../../session/ui-conversation-message-actions/.agents/adrs/20260917-引用的统一解析与渲染转换.md)。
