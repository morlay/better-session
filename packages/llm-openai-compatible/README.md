# @morlay/dsh-llm-openai-compatible

DeepSeek Harness 的 **OpenAI 兼容 LLM 适配器**插件。与内置 `llm-pi-ai` /
`llm-deepseek` 不同，本插件的配置 schema 支持 **profile 级默认采样参数**
（`temperature` / `topP` / `topK` / `presencePenalty` / `frequencyPenalty` /
`seed`），请求级 `GenerateOptions.temperature` 优先于 profile 默认值。用
`providers` dict 多路由结构（与 `llm-pi-ai` 一致），用户可将现有
`llm-pi-ai` 配置近乎无缝迁移。

传输层复用 **[@ai-sdk/openai-compatible](https://www.npmjs.com/package/@ai-sdk/openai-compatible)**
（`LanguageModelV4.doStream`：wire 序列化与 SSE 解析由 SDK 负责）；本插件负责
harness 消息 → AI SDK prompt 转换、采样默认合并、stream part → `StreamChunk`
翻译、错误归一化与凭据策略。

## 配置

`providers` 是 dict：**key 就是 provider 路由键**（选择器与
`GenerateOptions.provider` 使用），值是 profile。

```yaml
llm-openai-compatible:
  providers:
    ollama:
      apiKeyEnv: OLLAMA_API_KEY
      baseURL: https://ollama.com/v1
      displayName: Ollama Gateway
      # === 采样默认参数（请求级 temperature 优先）===
      temperature: 1 # 0..2
      topP: 0.95 # 0..1 → wire top_p
      topK: 40 # 正整数 → wire top_k（非标准，仅网关支持时发送）
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
```

### 采样默认值合并规则

| wire 字段                                                   | 取值                                                               | 省略语义                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `temperature`                                               | `options.temperature ?? profile.temperature`                       | 都不给 → 不发送，提供方默认 |
| `max_tokens`                                                | `options.maxTokens ?? model.maxTokens ?? profile.defaultMaxTokens` | 都不给 → 不发送             |
| `top_p` / `presence_penalty` / `frequency_penalty` / `seed` | `profile` 值                                                       | undefined → 不发送          |
| `top_k`                                                     | `profile.topK`，经 `providerOptions` 透传进请求体                  | undefined → 不发送          |
| `reasoning_effort`                                          | 见下                                                               | 解析不出 → 不发送           |

### reasoning 映射（OpenAI 风格）

- 模型声明 `reasoningEfforts`（对象）后，该模型的选器公开 `efforts`（按声明
  顺序）+ `defaultEffort`（= `profile.reasoning`，须在模型能力内，否则视为无
  默认值——**描述模型时绝不抛错**）。
- wire：非 `off` 档位发送 `reasoning_effort: <声明值>`；`off` → 不发送。
- 请求级 `options.reasoningEffort` 不在模型能力内 → 网络 I/O 前抛
  `LlmError('UNSUPPORTED_REASONING_EFFORT')`。`profile.reasoning` 配了模型不
  支持的档位 → 请求执行处失败（同一错误码），配置页面仍可编辑。
- 模型不声明 `reasoningEfforts`（或 `false`）→ 不公开 reasoning 能力。

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
  如本地 Ollama）。

## 传输

- 端点 = `baseURL` + `/chat/completions`（streaming，`stream_options.include_usage`）。
- 每个请求携带 `attributionHeaders()` + `x-…-harness-user-id`（+ session-id /
  compaction 标头），并带 SDK 的 `ai-sdk/openai-compatible` user-agent 后缀。
- `streamIdleTimeoutMs` 控制流空闲超时（`TIMEOUT`）；`timeoutMs` 控制整体请求
  超时（缺省不设）。
- 错误映射：401/403 → `AUTH`、429 → `RATE_LIMIT`、400+上下文 →
  `CONTEXT_WINDOW_EXCEEDED`、5xx → `SERVER`、配额 → `QUOTA_EXCEEDED`。
- 用量：`prompt_tokens_details.cached_tokens` 与 DeepSeek 方言的
  `prompt_cache_hit_tokens` 都被拆出为 `cacheReadTokens`（disjoint 计数）。

## 从 `llm-pi-ai` 迁移

把 `llm-pi-ai.providers.<route>` 的 `api`/`baseURL`/`models`/采样字段平移到
`llm-openai-compatible.providers.<route>`，`apiKeyEnv` 与 `retryPolicy` 原样
保留；`reasoningEfforts` 的 `off` 空值语义一致。

## 暂缓能力（YAGNI）

- 不做 `modelOverrides`（providers 里每个路由自己写 `models` 即可）。
- 不做模型 discovery（端点询问 `GET /models`）；需要时手写 `models`。
- 不做 OAuth / 非 bearer 认证。

## 构建与验证

```bash
pnpm install
pnpm --filter @morlay/dsh-llm-openai-compatible run prepare   # → lib/*.mjs + *.d.mts
pnpm exec tsc --noEmit
pnpm exec vitest run
```
