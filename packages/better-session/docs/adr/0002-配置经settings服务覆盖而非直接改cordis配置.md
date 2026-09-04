# 0002-配置经 settings 服务覆盖而非直接改 cordis 配置

`session-rdb` 的配置（SQLite / PostgreSQL 选择、路径、连接串等）经
`$DSH_HOME/settings.yaml` 的 `session-rdb` namespace 覆盖 cordis 层 entry
config（注册于 `ctx.settings`，见 `SessionPersistenceRdb.settingsNs`），
未写出的字段回落到 bundle patch / cordis.yml 的 config 默认值。默认配置为
SQLite（`$DSH_HOME/sessions/sessions.sqlite`）。

## 考虑过的选项

- **直接改 cordis.patch.yml 的 config**：bundle patch 是代码的一部分，
  用户改配置即改代码，升级会被覆盖。
- **环境变量**：无类型、无结构，多字段配置（type / path / journalMode /
  busyTimeout / connectionString）难以表达。

## 后果

- settings.yaml 是纯 YAML（settings-local 用 `yaml` 库解析），**不支持
  `!!js` JS 表达式**——`!!js dshHomePath(...)` 会被当作字面字符串；`!!js`
  只在 `cordis.patch.yml`（bundle patch 层，loader 求值）有效。
