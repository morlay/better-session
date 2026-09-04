# llm-ai-sdk 配置界面落地计划（下一步）

`@morlay/dsh-llm-ai-sdk` 需要与上游 `llm-pi-ai` 相同的 Web **Models 配置
体验**：设置页列出 provider、编辑 API key / baseURL / api 风格 / 模型目录，
写入 `llm-ai-sdk` settings namespace。

## 为什么不能只靠上游 Models 页

上游 `ui-settings-models`（`vendor/deepseek-harness/packages/client/
ui-settings-models/`）对 provider 卡片是 **namespace 硬编码**的：

- `ProviderEditor.layoutOf(ns)`（`ProviderEditor.tsx`）只认 `llm-deepseek` /
  `llm-pi-ai`，其他 namespace 落 `unknown`——只渲染 advanced hint，
  Apply 按钮 `submitDisabled`（`ModelsSection.tsx` / `ProviderEditor.tsx`）。
- 新 provider 下拉与目录行本身是泛型的（joinProviderDirectory /
  registerConfigurableProviders），第三方 adapter 的 provider 行会显示在
  Models 页，但点编辑只得到只读卡片。

因此第三方 adapter 要完整可配置，需要自研 client 设置 section。

## 目标实现（host + client 双面同包）

参照 `@morlay/ui-conversation-message-actions`（同包 host `src/index.ts` +
client `src/client/index.ts`，`cordis.patch.yml` 单条目插入即双面装配）：

1. `src/client/index.ts`：注册 `settings.section` 新 id 页面
   （`ctx.slots.inject('settings.section', () => ctx.slots.register({...},
   ProviderListSection))`），`label` 用本地化 thunk，`children` 可留空；
   `inject` = `['slots','locale','remote','remote.settings',
   'remote.credentials','settingsScope','settingsSchema']`（同
   `ui-settings-models/src/client/index.ts`）。
2. 页面数据：`ctx.settingsScope.bind({ namespace: 'llm-ai-sdk' })` 读
   namespace snapshot（`value`/`user`/`base`/`revision`/`writable`）；写经
   `scope.mutate(ops, expectedRevision)`；API key 写
   `ctx.remote.credentials.set(deriveKeyRef(provider), value)`（derive 规则同
   `ui-settings-models`：`<ROUTE>_API_KEY` 大写化），profile 的 `apiKeyEnv`
   落该 ref。
3. 表单：provider 行列表（目录可经 `ctx.remote.llm.listConfigurableProviders`
   join live routes，或直接读 namespace），每行编辑 `displayName` /
   `baseURL` / `api`（下拉 `LLM_APIS`）/ `models`（JSON 文本或逐行编辑）；
   schema 校验用 `settingsSchema`（`createSettingsSchemaOperations` 模式）。
4. 依赖声明（同 ui-conversation-message-actions 模式）：
   - peer：`@deepseek-ai/dsh-api-remotes`、`dsh-client-connection`、
     `dsh-client-store`、`dsh-client-ui-settings`、`dsh-client-ui-slots`、
     `dsh-client-ui-primitives`、`dsh-client-locale`、`dsh-llm` 等 client 契约面。
   - dev：react / @types/react / @types/react-dom / lightningcss。
   - `package.json` 增 `./client` export → `./dist/client.js`；
     `dsh.client: { platform: 'web' }`。
   - `tsdown.config.ts`：`defineCordisPluginConfig({ client: { name: ...,
     entry: 'src/client/index.ts' } })`。
   - `src/client/css-modules.d.ts`。
5. 装配：`cordis.patch.yml` 已有 `- id: llm-ai-sdk` 单条目，loader 对声明
   `dsh.client` 的包自动把它挂进 browser roster（
   `client-modules` 扫 Loader entries），无需改 web-app bundle patch；
   `apps/dsh-custom` 依赖已是 `@morlay/dsh-llm-ai-sdk`。

## 验证

- 本地 `just custom::dev` 起 GUI，打开 Settings → 新页：添加 provider、
  填 key、改 baseURL / api / models、Apply 后检查 `$DSH_HOME/settings.yaml`
  出现 `llm-ai-sdk.providers.<route>`。
- client 组件测试参照上游 `ui-settings-models/tests/*.client.spec.tsx`
  （jsdom pragma）与本仓库 `ui-conversation-message-actions` 测试模式。

## 上游约束备注

`vendor/deepseek-harness` 不可改（红线），所以不自改 `ProviderEditor.layoutOf`；
自研页完全绕开它。若未来上游开放第三方 namespace 编辑，可改为复用 Models 页
并撤销本页（本页按 `settings.section` 独立 id 注册，便于移除）。
