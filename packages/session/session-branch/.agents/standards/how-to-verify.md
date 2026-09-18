# 如何验证（契约投影）

通用规则（证据矩阵、失败处理、发布纪律）见根[如何验证](../../../../../.agents/standards/how-to-verify.md)；
这里只写本包的契约投影接缝与守护 spec。

## 接缝与守护 spec（`src/__tests__/`）

- **`balanceRewindPrefix`**（`balance.ts`）——含 step 配平自愈与 `keepOpenTail` 口径：
  `balance.spec.ts`。
- **`buildTimeline`**（`timeline.ts`）——版本树投影与日志不变量：`timeline.spec.ts`。

判据是**投影不变量**（版本树 / 时间线在 rewind、未闭合轮次、配平修复下的形状），不是实现细节。
