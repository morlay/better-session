# 0007-图片超预算报错交由 durable offload 重试

状态：已采纳

图片请求预算的所有权在上游：路由只把 surface 上已 offload 的图片替换为占位
文本（`projectOffloadedImages`），保留的图片按 base64 长度合计超过
`maxRequestImageBytes` 时抛 `LlmError('IMAGE_OFFLOAD_REQUIRED')`（经
`requiredImageOffload` 携带还需 offload 的最旧出现次数）。上游
`compaction-image-offload` 在 `agent/request-error` 里记录 durable 的
`image/offload` 事件并重试同一请求。本适配器不再自行裁剪请求图片。

## 考虑过的选项

- **沿用旧 API 由路由自行 offload**：上游已删除
  `offloadRequestImagesWithPolicy`；且路由局部裁剪不落 durable 事实，每次
  请求重算，重放与重试得不到同一份历史。
- **静默丢弃超预算图片**：模型看到的历史随请求漂移，与 surface 不一致。

## 后果

- 超预算不再静默：请求失败一次，durable offload 后重试成功；没有
  `compaction-image-offload` 装配时（纯后端）错误直接上抛。
- `maxRequestImageBytes` 口径为 base64 长度（图片以 data URL 内联），比旧
  实现按原始字节计更严格。
