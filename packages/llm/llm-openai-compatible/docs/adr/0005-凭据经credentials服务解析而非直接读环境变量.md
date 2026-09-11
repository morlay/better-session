# 0005-凭据经 credentials 服务解析而非直接读环境变量

profile 设置 `apiKeyEnv` 后经 `ctx.credentials` 解析（服务缺失时回退
`launchEnvironmentOf(ctx)`）；解析不到 → `LlmError('MISSING_CREDENTIAL')`。
不设置 → 请求不带 `authorization` 头（无认证端点，如本地 Ollama）。现状细节
见 [README](../../README.md)。

## 考虑过的选项

- **直接读 `process.env`**：绕过 harness 的凭据服务——web Models 页面写入
  的凭据不可见，且与 launch environment 机制脱节。
- **强制要求凭据**：无认证端点（本地 Ollama）无法使用。

## 后果

- 凭据缺失时错误信息指引用户「通过 credentials 服务（web Models 页面）或
  launch environment 提供」。
