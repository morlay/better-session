# 0001-起因：llm-pi-ai 的请求参数配置不完整

内置 `@deepseek-ai/dsh-llm-pi-ai` 的 provider profile schema 只覆盖端点、
模型目录、reasoning 档位、thinking 预算、缓存保留、传输与重试策略——
**没有采样参数**（`temperature` / `topP` / `topK` / `presencePenalty` /
`frequencyPenalty` / `seed` 均不在 `PiAiProviderProfile` 内），请求级
`GenerateOptions` 之外的采样默认值无法配置。本插件因此存在：为 OpenAI
兼容端点提供 **profile 级默认采样参数**（请求级 `GenerateOptions.temperature`
优先），并复用 `llm-pi-ai` 的 dict 多路由结构使现有配置近乎无缝迁移。

## 考虑过的选项

- **给 `llm-pi-ai` 补采样参数**：上游 `@deepseek-ai/*` 代码不可修改
  （node_modules 只读，扩展走 cordis 插件层）。
- **请求级每次显式传参**：调用方（agent-loop / 工具）不携带采样参数时
  无默认可依，提供方默认不可控。

## 后果

- 采样默认值合并规则（`options.temperature ?? profile.temperature`，省略 =
  不发送 = 提供方默认）成为本插件的核心差异点（见 0006）。
- 与 `llm-pi-ai` 并存：两者都注册 `ctx.llm` 适配器，路由冲突时后注册者
  拒绝（原子注册）；用户按需挂载其一或分路由共存。
