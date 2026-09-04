# LLM 适配

为 DeepSeek Harness 提供 **AI SDK LLM 适配器**插件的领域：把 harness
消息转换为 AI SDK prompt、合并采样默认参数、翻译 stream part、归一化错误
与凭据策略。传输层复用 AI SDK 三个提供方（`@ai-sdk/openai-compatible` /
`@ai-sdk/openai` / `@ai-sdk/open-responses`，profile 级 `api` 风格选择），
本插件只负责适配。

## 配置与路由

**provider 路由（provider route）**：
`providers` dict 的 key——选择器与 `GenerateOptions.provider` 使用的路由键，
值是 profile。
_避免使用_：provider 名、路由名

**profile**：
单个 provider 路由的完整配置：凭据引用、传输风格、baseURL、采样默认参数、
模型目录、传输参数与重试策略。
_避免使用_：配置块、provider 配置

**传输风格（api style）**：
profile 级 `api` 字段——`openai-compatible`（chat completions 泛兼容，
默认）/ `openai`（官方 OpenAI chat surface）/ `open-responses`（Responses
API）。三者都实现 AI SDK `LanguageModelV4`，序列化与翻译共享，仅
providerOptions key 与 reasoning 传递按风格分支。
_避免使用_：协议、后端类型

**采样默认参数（sampling defaults）**：
profile 级默认采样参数（`temperature` / `topP` / `topK` /
`presencePenalty` / `frequencyPenalty` / `seed`）——请求级
`GenerateOptions.temperature` 优先于 profile 默认值。
_避免使用_：采样配置、默认采样

**模型目录（model catalog）**：
profile 内 `models` 列表——声明模型能力（contextWindow / maxTokens /
inputModalities / reasoningEfforts）。缺省 = 服务**空目录**：`listModels`
返回空，未列出的 id 原样透传。
_避免使用_：模型列表、模型注册表

**reasoning 档位（reasoning effort）**：
`off` / `low` / `high` / `max` 四档。模型声明 `reasoningEfforts` 后选器公开
`efforts` + `defaultEffort`（= `profile.reasoning`）；`off` 空值 = 不发送
`reasoning_effort`。
_避免使用_：推理级别、思考档位

## 请求与传输

**wire 字段**：
发送到端点的请求体字段（`temperature` / `max_tokens` /
`top_p` / `reasoning_effort` 等）——采样默认值合并的落点。
_避免使用_：请求字段、传输字段

**stream part**：
AI SDK 流式响应单元——本插件翻译为 harness `StreamChunk`。
_避免使用_：流块、chunk

**流空闲超时（stream idle timeout）**：
`streamIdleTimeoutMs` 控制流空闲超时（`TIMEOUT`）；`timeoutMs` 控制整体
请求超时（缺省不设）。
_避免使用_：空闲超时、流超时

**错误归一化（error normalization）**：
HTTP 状态 + 错误体 → harness `LlmError` 码：401/403 → `AUTH`、429 →
`RATE_LIMIT`、400+上下文 → `CONTEXT_WINDOW_EXCEEDED`、5xx → `SERVER`、
配额 → `QUOTA_EXCEEDED`。
_避免使用_：错误映射、错误翻译

**凭据策略（credential policy）**：
profile 设置 `apiKeyEnv` 后：`ctx.credentials` 优先，其次
`launchEnvironmentOf(ctx)`；解析不到 → `MISSING_CREDENTIAL`。不设置 →
请求不带 `authorization` 头（无认证端点，如本地 Ollama）。
_避免使用_：认证方式、密钥解析

**cacheReadTokens**：
chat 系 `prompt_tokens_details.cached_tokens` / DeepSeek 方言
`prompt_cache_hit_tokens` 与 responses 系 `input_tokens_details.cached_tokens`
拆出的缓存读取 token（disjoint 计数）。
_避免使用_：缓存 token、命中 token
