# token meter 水位按位置前进，原地重写日志需主动失效

状态：未销账（由我们在自己的接缝上每次截断后主动失效上游 meter 的折叠状态）

**现象**

上游 `ctx.tokenMeter` 对同一 `Session` 只做增量折叠，水位 `consumedEvents` 记的是
**位置**（`session.eventAt(seq)` 的下标），不是事件身份。任何**原地重写或截断**会话
内存 log 的操作（rewind、覆盖导入）都会把水位留在被删除 / 被重写的 seq 空间；续写让
日志重新长过旧水位后，折叠从错位处继续，于是压缩测量抛
`token meter: step/end at seq N has no matching step/start event`（手动 `/compact`
在 UI 上显示为「compact token meter: …」）。表现是「奇怪的时机、非必现」，因为落点
是否为 `step/end` 取决于数据。

我们只在**自己的接缝**上规避，不改上游：

- rewind 与覆盖导入在截断后主动失效该会话的 meter 折叠与投影单元缓存
  （`resetTokenMeterFold` / `resetProjectionCells` / `resetLiveDerivedState`），
  并对失效调用做**能力探测**（服务缺失或内部结构不符时记明确告警，每插件实例一次）
  ——失效依赖上游私有字段（`TokenMeter.states`、投影的 `cells`、服务的
  `registrations`），告警是防止「上游改结构后修复静默失灵」的哨兵；
- 截断的 step 配平分两侧：**rewind 只按尾部窗口配平**（`rewindKeepLength`，不扫
  全量日志，保留前缀内部既有破损不自愈）；**整段日志的路径**（fork seed / 导出 /
  导入）走 `balanceRewindPrefix` 前向扫描自愈——已不平衡则丢弃尾部并告警，导出与
  导入保留**合法的**未闭合尾部（中断运行的正常形状，由上游 resume 补 closers）。

**影响**

上游同步或调整 token meter 内部结构后，这套 duck-type 失效可能静默失灵——那时用户会在「奇怪的
时机」看到 compact 报错（手动 `/compact`），而不是在 rewind 当下。失效调用做了能力探测 + 告警，
所以失灵会先在日志里出现告警，而不是无提示地坏掉。

**触发条件**

- 每次改动 `session-rdb` 的截断 / 导入路径，或改动 `ui-conversation-message-actions` 的重放路径时，
  必须确认失效调用仍在生效（守护测试见下）；
- 上游提供下列任一能力时，结算本记录。

**销账条件**

Done when：上游满足任一项，我们侧的 duck-type 失效被删除：

1. fold 状态按事件身份（或日志世代 / 修订号）校验，检测到水位回退或日志被重写时
   自行失效；
2. 提供公开的失效 / 回滚 API（例如 `ctx.tokenMeter.invalidate(session)`）。

回退动作：

- 删除我们侧的 duck-type 失效调用与能力探测告警，改用上游公开 API；
- `balanceRewindPrefix` 的配平自愈可以保留（它守护的是日志不变量本身），但把「为
  meter 保险」的那部分说明同步改写；
- 结算本记录。

**不修的理由**

修不了上游（红线：`@deepseek-ai/*` 不可修改），只能在我们侧规避；而规避本身已经带了能力探测与
配平自愈，代价是上游改结构时要跟一次告警。

## 基线

- 基线版本：`DEEPSEEK_HARNESS_VERSION`（见根 `mise.toml`）；
- 失败模式与截断语义：[packages/session/session-rdb/.agents/designs/0002-分支能力.md](../../packages/session/session-rdb/.agents/designs/0002-分支能力.md)；
- 守护测试（同一 meter 实例 + 预热水位）：
  `packages/session/session-rdb/src/__tests__/{branch,import}.spec.ts`、
  `packages/session/ui-conversation-message-actions/src/__tests__/meter-watermark.spec.ts`
  （多 op 叠加 / agent loop 续跑 / compaction 入口）。
