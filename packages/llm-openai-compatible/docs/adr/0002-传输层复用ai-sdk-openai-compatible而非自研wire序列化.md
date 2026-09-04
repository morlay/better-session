# 0002-传输层复用 @ai-sdk/openai-compatible 而非自研 wire 序列化

传输层复用 **[@ai-sdk/openai-compatible](https://www.npmjs.com/package/@ai-sdk/openai-compatible)**
（`LanguageModelV4.doStream`：wire 序列化与 SSE 解析由 SDK 负责）；本插件
只负责 harness 消息 → AI SDK prompt 转换、采样默认合并、stream part →
`StreamChunk` 翻译、错误归一化与凭据策略。

## 考虑过的选项

- **自研 wire 序列化与 SSE 解析**：需要维护 OpenAI 兼容协议的全部细节
  （SSE 解析、错误体、用量字段方言），且与 AI SDK 生态脱节。
- **复用 `@ai-sdk/openai-compatible`**：协议细节由 SDK 维护，本插件聚焦
  harness 适配；代价是受 SDK 的 `LanguageModelV4` 接口约束。

## 后果

- 非标准字段（`top_k`）经 `providerOptions` 透传进请求体。
- 用量转换（`convertUsage`）需兼容 DeepSeek 方言
  （`prompt_cache_hit_tokens`）。
