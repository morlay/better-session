---
name: dsh-plugin-implement
description: 实现插件改动时用——先约定接缝再写测试（红→绿），按证据矩阵选验证、明确什么算完成。含 TDD 循环、反模式入口与完成判据
---

# 实现（implement）

设计已定（见 `dsh-plugin-design`）后走这条线：**接缝先约定，测试先红。**

动手前读两处：[`AGENTS.md`](../../../AGENTS.md)（必读、home 表、边界）与
[`.agents/standards/`](../../standards)（如何写 / 如何验证）。

## 一、先约定接缝

接缝是调用方与测试共同的边界。写任何测试之前，先把这次要穿的接缝写下来并与用户确认：

- **契约面**——上游类型 / 服务的公开面，以及我们自己的 branded 类型与错误类型；
- **服务与依赖的公开面**——本仓库插件的 `ctx.<service>`（如 `ctx.sessionBranch`、`ctx.sessionEditor`、
  `ctx.sessionPersistence`）取值与注入的地方；
- **装配面**——`cordis.patch.yml`、依赖声明（`workspace:^` 放 peer 还是 dev）、client 声明；
- **出口与命令**——包暴露什么、HTTP 路由（如 `/session-editor`）与命令行 / just 命令的对外行为。

本仓库这些接缝具体落在哪，见**改动所属层**的 `.agents/standards/`——不复制其中条目。

没确认接缝就不写测试。测试只写在接缝上：不 mock 内部协作者、不测私有成员、不绕过接口查内部状态
（直读库表、读私有字段）。

## 二、循环：一轮一个垂直切片

1. 写一个**会失败**的测试，只覆盖这一轮要的行为（一发曳光弹）；
2. 写**刚好**让它通过的实现；
3. 跑它，绿了进下一轮。

- 不先写完所有测试再写实现（水平切片）；不预写下一轮的测试；不加规格没要求的抽象与钩子。
- 重构不属于循环——它在 `dsh-plugin-review`；结构性重构在 `dsh-plugin-improve`。
- 上游侧的改动（vendor 内容、patch、EXCLUDE、版本跟随）走 `dsh-plugin-upstream-sync`，不在本循环内。

测试落在哪、怎么命名、跑在什么环境、各包的测试装配辅助与日志 fixture → **改动所属层**的
`.agents/standards/`（通用部分在根 `standards/how-to-verify.md`）。

三条反模式 → [`references/testing-antipatterns.md`](./references/testing-antipatterns.md)。

## 三、验证与完成判据

按 `.agents/standards/`（通用）与改动所属层 standards（包特有）选**最小充分**证据；命令入口是仓库根的
`justfile`（`just --list` 看全量：`just test` / `just lint` / `just build`；上游或 pg 相关加
`just vendor …` / `just pg test`）。

完成判据，缺一条就不算完成：

1. 行为有测试，且该测试会在回归时失败；
2. 所选证据跑过，并贴出真实结果（不是「应该能过」）；
3. lint（含 type-aware 类型检查）/ format 没有引入**新**错误；
4. 记录同步：动了边界、契约或流程，就更新对应的 home（home 表见 `AGENTS.md`）。

不做：不为过测试改断言——行为变了就连测试一起改并说明；不动只读区。

## 四、边界与交接

- 只读区（上游 `@deepseek-ai/*`、`node_modules`）、依赖方向、发布纪律（发布走 CI，严禁本地 publish）
  → [`AGENTS.md`](../../../AGENTS.md) 与 `.agents/standards/`。
- 上游（只读依赖）侧的改动 → `dsh-plugin-upstream-sync`。
- 实现完待审 → `dsh-plugin-review`。
