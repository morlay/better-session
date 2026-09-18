# @morlay/dsh-llm-openai-compatible

DeepSeek Harness 的 **OpenAI 兼容 LLM 适配器**插件。与内置 `llm-pi-ai` /
`llm-deepseek` 不同，本插件的配置 schema 支持 **profile 级默认采样参数**
（`temperature` / `topP` / `topK` / `presencePenalty` / `frequencyPenalty` /
`seed`），请求级 `GenerateOptions.temperature` 优先于 profile 默认值；`providers`
用 dict 多路由结构（与 `llm-pi-ai` 一致）。

传输层复用 **[@ai-sdk/openai-compatible](https://www.npmjs.com/package/@ai-sdk/openai-compatible)**
（wire 序列化与 SSE 解析由 SDK 负责）；本插件负责 harness 消息 → AI SDK prompt
转换、采样默认合并、stream part → `StreamChunk` 翻译、错误归一化与凭据策略。

本文件只给配置面与用法；每条规则与取舍的 home 是各自 ADR（见下）。

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

## 规则与取舍

规则细节（合并表、wire 字段落点、端点与错误映射）在各自 ADR 里维护，这里只列结论：

- **采样默认值与省略语义**：请求级优先于 profile 默认，缺省一律**不发送**（= 提供方
  默认）——见 [ADR-采样默认值合并规则与省略语义](./.agents/adrs/20260917-采样默认值合并规则与省略语义.md)。
- **模型目录缺省为空、描述模型绝不抛错**：未列出的 id 原样透传，不支持的能力配置推迟到
  请求执行处失败——见 [ADR-模型目录缺省为空且描述模型绝不抛错](./.agents/adrs/20260917-模型目录缺省为空且描述模型绝不抛错.md)。
- **传输层复用 SDK**：非标准字段（`top_k`）与用量方言在本层显式处理——见
  [ADR-传输层复用ai-sdk-openai-compatible而非自研wire序列化](./.agents/adrs/20260917-传输层复用ai-sdk-openai-compatible而非自研wire序列化.md)。
- **凭据经 `ctx.credentials` 解析**（服务缺失回退 launch environment）：见
  [ADR-凭据经credentials服务解析而非直接读环境变量](./.agents/adrs/20260917-凭据经credentials服务解析而非直接读环境变量.md)。
- **图片超预算报错交由 durable offload 重试**（本适配器不自行裁剪请求图片）：见
  [ADR-图片超预算报错交由durable-offload重试](./.agents/adrs/20260917-图片超预算报错交由durable-offload重试.md)。
- **多路由结构对齐 `llm-pi-ai`**（数组式 profiles 被拒绝）：见
  [ADR-providers采用dict多路由结构对齐llm-pi-ai](./.agents/adrs/20260917-providers采用dict多路由结构对齐llm-pi-ai.md)
  与 [ADR-起因llm-pi-ai的请求参数配置不完整](./.agents/adrs/20260917-起因llm-pi-ai的请求参数配置不完整.md)。
- **未做（YAGNI）**：`modelOverrides`、模型 discovery（`GET /models`）、OAuth / 非
  bearer 认证——理由见模型目录 ADR。

## 从 `llm-pi-ai` 迁移

把 `llm-pi-ai.providers.<route>` 的 `baseURL` / `models` / 采样字段平移到
`llm-openai-compatible.providers.<route>`（无 `api` 字段——协议固定
chat-completions），`apiKeyEnv` 与 `retryPolicy` 原样保留；`reasoningEfforts`
的 `off` 空值语义一致。

构建、测试与类型检查的命令见根 `justfile` 与 `mise.toml`。
