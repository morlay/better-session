# 0003-providers 采用 dict 多路由结构对齐 llm-pi-ai

`providers` 是 **dict：key 就是 provider 路由键**（选择器与
`GenerateOptions.provider` 使用），值是 profile——与内置 `llm-pi-ai` 的
多路由结构一致，用户可将现有 `llm-pi-ai` 配置近乎无缝迁移（`api` /
`baseURL` / `models` / 采样字段平移，`apiKeyEnv` 与 `retryPolicy` 原样
保留，`reasoningEfforts` 的 `off` 空值语义一致）。

## 考虑过的选项

- **数组式 profiles**：`resolveProfiles` 对数组显式抛错（"providers is now
  a dict keyed by provider route, not an array of profiles"）——早期形态，
  迁移到 dict 后拒绝旧形态。
- **单 provider 单配置**：无法表达多端点路由（Ollama + 网关 + 云端并存）。

## 后果

- 配置 schema 支持 **profile 级默认采样参数**（`temperature` / `topP` /
  `topK` / `presencePenalty` / `frequencyPenalty` / `seed`），请求级
  `GenerateOptions.temperature` 优先——这是与内置 `llm-pi-ai` /
  `llm-deepseek` 的差异点。
