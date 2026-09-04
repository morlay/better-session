# 0007-支持 AI SDK 三传输风格并更名为 llm-ai-sdk

原 `@morlay/dsh-llm-openai-compatible` 更名为 **`@morlay/dsh-llm-ai-sdk`**
（目录 `packages/llm-ai-sdk`，插件名 / settings namespace `llm-ai-sdk`），
profile 级 `api` 字段选择 AI SDK 提供方：

- `openai-compatible`（默认）— `@ai-sdk/openai-compatible` 的 chat surface。
- `openai` — `@ai-sdk/openai` 的 chat surface。
- `open-responses` — `@ai-sdk/open-responses`（Responses API，`url` =
  Responses POST endpoint）。

## 考虑过的选项

- **继续单风格 openai-compatible**：无法覆盖官方 OpenAI 能力表 /
  Responses API 用户。
- **独立 `@ai-sdk/openai` 的 `.responses()` 作为第四个 `api` 值**：官方
  Responses surface 与独立 `@ai-sdk/open-responses` 功能重叠；本阶段
  YAGNI，需要时再加 `api: openai-responses` 值。
- **为每风格各写一套序列化 / 翻译**：三个后端都实现同一 AI SDK
  `LanguageModelV4`（prompt parts 与 stream parts 同型同语义），
  serialize / translate / 错误归一化 / usage 映射全部共享；只有
  providerOptions key（`openai-compatible` / `openai` / `open-responses`）、
  reasoning effort 落点与 `top_k` 支持（官方后端丢弃）按风格分支。

## 后果

- `serialize.ts` / `translate.ts` 继续以 `LanguageModelV4` 为唯一接口，
  三风格零复制。
- `transport.ts` 承担风格选型与 SDK 工厂缓存（按 profile + apiKey 分组，
  官方 openai 工厂把 key 闭包进请求 headers，key 变则重建模型实例）。
- `openai` 风格要求 profile 配置 `apiKeyEnv`：官方工厂强制读 key 或
  `OPENAI_API_KEY` env，每请求解析后经 `authorization` 头覆盖。
- `openai` chat surface 不解析 `reasoning_content`，reasoning 不落 parts；
  `open-responses` / `openai-compatible` 则有——文档已注明。
- 旧配置无缝迁移：只改 settings namespace 名为 `llm-ai-sdk`，profile 字段
  不变（未声明 `api` 走默认 `openai-compatible`）。
