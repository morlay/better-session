# @morlay/dsh-client-ui-chat

上游 `@deepseek-ai/dsh-client-ui-chat` 的**整包 fork**（host 半 + client 半），由本仓库维护：
一对一替换官方 `ui-chat` 行（禁用官方行），消息槽声明与 Chat 设置命名空间保持同形。

接管的原因、与上游的差异清单与回退条件登记在根 [债务 0001](../../../.agents/debts/0001-临时接管上游对话UI的client半.md)；
fork 的口径（哪些改动必须补测试）见 [规范「fork 包的口径」](../../../.agents/standards/how-to-verify.md)。

测试落点在 `src/__tests__/`（jsdom 用例首行 `// @vitest-environment jsdom`）。
