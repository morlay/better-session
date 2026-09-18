# 如何验证（装配面）

`@morlay/better-session` 的装配面是 `cordis.patch.yml` ↔ 包依赖 ↔ client 声明三者的一致性：发布出去的
bundle 一旦断链，装配在别人机器上静默失效。改 patch、改依赖、改 fork 包出口或平台声明，都按下面判据验证。

守护测试（`packages/session/better-session/src/__tests__/`，命令 `just test <spec 路径>`）：

- `assembly.spec.ts` —— 依赖 ↔ patch ↔ client 声明的一致性；
- `patch.spec.ts` —— patch 的形状（禁用的官方行、insert 的 id 不与上游撞名）。

## 判据

- **每个 insert 行可解析**：patch 里 insert 的包名必须能在工作区解析到真实包，且该包有 host 出口
  （`exports["."]`）。
- **插入面 == 依赖面**：patch 插入的包名集合与本 bundle 的 `dependencies` **互为相等**——只声明不装配、
  只装配不声明都错。
- **fork 的 client 包声明齐全**：insert 的每个 `@morlay/dsh-client-ui-*` 必须声明 `./client` 的 `types` 与
  `default`（client-modules 的入口），且 `dsh.client.platform` 为 `web`。
- **宿主内嵌的编排层 client 半**：`@morlay/ui-conversation-message-actions` 的 `dsh.client.inject` 必须含
  `@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-client-store`。
- **patch 的形状**：禁用的官方行集合、insert 的行 id 集合与预期逐项相等；insert 的 id 不得与上游 bundle
  行 id 撞名，且禁用的行 id 必须仍存在于上游 bundle（`vendor/deepseek-harness/packages/bundle/{base,web-app}/cordis.patch.yml`）。
- **同 id 重复 insert 是有意设计**：本 patch 插入的 id 与各子包自己的 bundle patch 相同
  （`session-branch` / `session-rdb` / `ui-conversation-message-actions` / `ui-primitives-fork`）——
  每个子包都要能作为**独立 bundle** 被采用，所以同一行 id 在不同 bundle 里各插一次是正常形态，
  不是撞名。本 bundle 因此自包含（装上就全套可用）；判据是**本 patch 内的 id 互不重复**、
  **不与上游行 id 撞名**，而不是与子包 patch 去重。
