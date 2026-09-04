# @morlay/dsh-llm-ai-sdk

DeepSeek Harness 的 **AI SDK LLM 适配器**插件。传输层复用 AI SDK（Vercel）
三个提供方，profile 级 `api` 字段选择：

- **`openai-compatible`**（默认）— [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)，
  chat completions 泛兼容端点（Ollama / 各类网关）。
- **`openai`** — [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai) 的
  chat surface（官方 OpenAI 能力表 / strict JSON schema）。
- **`open-responses`** — [`@ai-sdk/open-responses`](https://www.npmjs.com/package/@ai-sdk/open-responses)
  的 Responses API（`url` = Responses POST 完整 endpoint）。

与内置 `llm-pi-ai` / `llm-deepseek` 不同，本插件的配置 schema 支持
**profile 级默认采样参数**（`temperature` / `topP` / `topK` /
`presencePenalty` / `frequencyPenalty` / `seed`），请求级
`GenerateOptions.temperature` 优先于 profile 默认值。用 `providers` dict
多路由结构（与 `llm-pi-ai` 一致），用户可将现有 `llm-pi-ai` 配置近乎无缝
迁移。

三个传输后端都实现同一个 AI SDK `LanguageModelV4` 接口（wire 序列化与 SSE
解析由各 SDK 负责），因此 harness 消息 → prompt 转换、采样默认合并、
stream part → `StreamChunk` 翻译、错误归一化与凭据策略全部共享，只有
providerOptions 的 key / reasoning_effort 传递按 `api` 风格分支。

## 配置

`providers` 是 dict：**key 就是 provider 路由键**（选择器与
`GenerateOptions.provider` 使用），值是 profile。

```yaml
llm-ai-sdk:
  providers:
    ollama:
      apiKeyEnv: OLLAMA_API_KEY
      api: openai-compatible # 默认；省略即此值
      baseURL: https://ollama.com/v1
      displayName: Ollama Gateway
      # === 采样默认参数（请求级 temperature 优先）===
      temperature: 1 # 0..2
      topP: 0.95 # 0..1 → wire top_p
      topK: 40 # 正整数 → wire top_k（openai-compatible 网关；官方后端丢弃）
      presencePenalty: 0 # -2..2 → wire presence_penalty
      frequencyPenalty: 0 # -2..2 → wire frequency_penalty
      seed: 42 # 正整数 → wire seed
      # === 推理 ===
      reasoning: high # 部署默认档位（省略 = 提供方默认）
      # === 模型目录 ===
      defaultContextWindow: 262144
      defaultMaxTokens: 32768
      models:
        - id: deepseek-v4-flash:0731
          name: DeepSeek V4 Flash
          contextWindow: 1000000
          maxTokens: 65535
          inputModalities: [text, image]
          reasoningEfforts:
            off: # off 空值 = 不发送 reasoning_effort
            high: high # 档位 → wire reasoning_effort 拼写
            max: max
      # === 传输 ===
      maxRequestImageBytes: 20971520
      streamIdleTimeoutMs: 300000
      timeoutMs: 600000 # 整体请求超时；缺省不设
      retryPolicy:
        mode: normal
        maxRetries: 5

    # 官方 OpenAI chat completions（@ai-sdk/openai）。
    openai-official:
      api: openai
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://api.openai.com/v1 # 省略则用 SDK 默认
      models:
        - id: gpt-4o
          name: GPT-4o

    # Responses API（@ai-sdk/open-responses；url = Responses POST endpoint）。
    openai-responses:
      api: open-responses
      apiKeyEnv: OPENAI_API_KEY
      baseURL: https://api.openai.com/v1/responses
      models:
        - id: gpt-4o
```

### 采样默认值合并规则

| wire 字段                                                   | 取值                                                               | 省略语义                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `temperature`                                               | `options.temperature ?? profile.temperature`                       | 都不给 → 不发送，提供方默认 |
| `max_tokens`                                                | `options.maxTokens ?? model.maxTokens ?? profile.defaultMaxTokens` | 都不给 → 不发送             |
| `top_p` / `presence_penalty` / `frequency_penalty` / `seed` | `profile` 值                                                       | undefined → 不发送          |
| `top_k`                                                     | `profile.topK`，经 `providerOptions` 透传进请求体                  | 仅 `openai-compatible`；官方后端丢弃并告警 |
| `reasoning_effort`                                          | 见下                                                               | 解析不出 → 不发送           |

### reasoning 映射（OpenAI 风格）

- 模型声明 `reasoningEfforts`（对象）后，该模型的选器公开 `efforts`（按声明
  顺序）+ `defaultEffort`（= `profile.reasoning`，须在模型能力内，否则视为无
  默认值——**描述模型时绝不抛错**）。
- wire：非 `off` 档位发送 `reasoning_effort: <声明值>`；`off` → 不发送。
  请求体按 `api` 风格落在对应 providerOptions key
  （`openai-compatible` / `openai` / `open-responses`）的 `reasoningEffort`
  下，任意 wire 拼写三个 SDK 均直通不校验。
- 请求级 `options.reasoningEffort` 不在模型能力内 → 网络 I/O 前抛
  `LlmError('UNSUPPORTED_REASONING_EFFORT')`。`profile.reasoning` 配了模型不
  支持的档位 → 请求执行处失败（同一错误码），配置页面仍可编辑。
- 模型不声明 `reasoningEfforts`（或 `false`）→ 不公开 reasoning 能力。
- 注意：官方 `openai` chat surface 不解析 `reasoning_content` delta，因此该
  后端的 reasoning 不会透出 reasoning parts；`open-responses` 与
  `openai-compatible`（兼容解析）则有。

### 模型目录

- `models` 缺省 = 服务**空目录**：`listModels` 返回空，未列出的 id 原样透传
  （`resolveModel` 返回基础信息 + `defaultContextWindow` / `defaultMaxTokens`）。
- 模型 `maxTokens` 配置后成为该模型的 per-request 默认输出上限。
- `inputModalities` 缺省 `[text]`；声明含 `image` 的模型接受图片输入
  （attachments seam，base64 data-URL parts）。

### 凭据

- profile 设置 `apiKeyEnv` 后：`ctx.credentials` 优先，其次
  `launchEnvironmentOf(ctx)`；解析不到 → `LlmError('MISSING_CREDENTIAL')`。
- profile 不设置 `apiKeyEnv` → 请求不带 `authorization` 头（无认证端点，
  如本地 Ollama）。`openai`（官方 `@ai-sdk/openai`）风格要求 key：其工厂强制
  读取 key 或 `OPENAI_API_KEY` env，所以该风格 profile 应配置 `apiKeyEnv`
  （每请求解析后经 `authorization` 头覆盖）。

## 传输

- `openai-compatible` / `openai`：端点 = `baseURL` + SDK 的
  `/chat/completions`（streaming，`stream_options.include_usage`）；
  `open-responses`：端点 = `baseURL`（即 Responses POST endpoint）。
- 每个请求携带 `attributionHeaders()` + `x-…-harness-user-id`（+ session-id /
  compaction 标头），并带各 SDK 的 `ai-sdk/<pkg>` user-agent 后缀。
- `streamIdleTimeoutMs` 控制流空闲超时（`TIMEOUT`）；`timeoutMs` 控制整体请求
  超时（缺省不设）。
- 错误映射：401/403 → `AUTH`、429 → `RATE_LIMIT`、400+上下文 →
  `CONTEXT_WINDOW_EXCEEDED`、5xx → `SERVER`、配额 → `QUOTA_EXCEEDED`。
- 用量：三个后端都归一到 AI SDK `LanguageModelV4Usage`，`cacheRead` 与
  `reasoning` 拆出为 `cacheReadTokens` / `reasoningTokens`（chat 系读
  `prompt_tokens_details.cached_tokens` 与 DeepSeek 方言
  `prompt_cache_hit_tokens`；responses 系读 `input_tokens_details.cached_tokens`）。

## 从 `llm-pi-ai` 迁移

把 `llm-pi-ai.providers.<route>` 的 `api`/`baseURL`/`models`/采样字段平移到
`llm-ai-sdk.providers.<route>`（命名空间换 `llm-ai-sdk`），`apiKeyEnv` 与
`retryPolicy` 原样保留；`reasoningEfforts` 的 `off` 空值语义一致。旧包名
`@morlay/dsh-llm-openai-compatible` 的配置以 `llm-ai-sdk:` 为命名空间即可，
profile 字段不变。

## 配置界面（下一步）

与 `llm-pi-ai` 相同的 Web Models 配置体验（设置页列出 provider、编辑
API key / baseURL / api 风格 / 模型目录）以上游 `ui-settings-models` 对
第三方 namespace 硬编码只读，需自研 client `settings.section` 页。计划落地
于本包的 `src/client/`（host + client 双面，同
`@morlay/ui-conversation-message-actions` 先例），本轮未含，见
[docs/CLIENT-PAGE-PLAN.md](docs/CLIENT-PAGE-PLAN.md)。

## 暂缓能力（YAGNI）

- 不做 `modelOverrides`（providers 里每个路由自己写 `models` 即可）。
- 不做模型 discovery（端点询问 `GET /models`）；需要时手写 `models`。
- 不做 OAuth / 非 bearer 认证。
- 不做独立 `@ai-sdk/open-responses` 之外的 responses 变体（官方
  `@ai-sdk/openai` 的 `.responses()` surface 已由 `open-responses` 风格覆盖，
  需要时再加 `api: openai-responses` 值）。

## 构建与验证

```bash
pnpm install
pnpm --filter @morlay/dsh-llm-ai-sdk run build   # → dist/*.mjs + *.d.mts
pnpm exec tsc --noEmit
pnpm exec vitest run
```
