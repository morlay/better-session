# 如何验证（Seatbelt e2e 门控）

通用规则（证据矩阵、失败处理、发布纪律）见根[如何验证](../../../../../.agents/standards/how-to-verify.md)；
这里只写本包的环境门控与落点。

## 常规落点（`src/__tests__/`）

- `dialects.spec.ts` / `rules.spec.ts` / `patch.spec.ts` / `plugin.spec.ts`：策略方言、规则编排、patch
  形状与插件装配——纯 node，任何平台可跑。

## Seatbelt e2e 门控（本地人工验证）

- `seatbelt.e2e.spec.ts` 只在 **macOS 且 `/usr/bin/sandbox-exec` 探针可用**时执行（`platform !==
"darwin"` 或探针非零即跳过）。
- **CI（ubuntu）恒跳过**——它不是 CI 证据，属**本地人工验证**：改动沙箱策略、额外可写根或拒绝项后，
  在本机跑一次这条 e2e 并贴输出。
