# 如何验证

「验证过」= 有**最小充分**的证据，并且贴出真实输出。命令入口在根 [`justfile`](../../justfile)
（`just --list`），版本见 [`mise.toml`](../../mise.toml)。

## 证据矩阵

按改动落在哪选证据，够用就好——不要反射式跑全量：

| 改动                        | 至少跑                                                                           |
| --------------------------- | -------------------------------------------------------------------------------- |
| 单包源码                    | 该行为对应的测试（`just test <受影响的 spec>`，接缝见该包 `.agents/standards/`） |
| 跨包契约 / 公共类型面       | 涉及包的测试，加全量 `just test`                                                 |
| 测试 / 构建配置、依赖       | 全量 `just test`                                                                 |
| 浏览器半（client bundle）   | 相关 jsdom 用例 + `just build`                                                   |
| 包出口、构建路径            | `just build`                                                                     |
| 文档与记录                  | 相对链接可达、无悬挂引用                                                         |
| vendor 上游（同步 / patch） | 全量 `just test` + `just lint` + `just build`                                    |

## 测试落点

- 位置：各包 `src/__tests__/`（vitest include `packages/**` 与 `devpackages/**` 下的
  `src/__tests__/**/*.spec.ts(x)`，exclude `node_modules` 与 `target`）；共享辅助放该包
  `src/testing/`，经 `./testing` 出口暴露。共享工具链 `devpackages/devkit` 同形——它没有
  自己的构建链，被测的构建行为（如 `bundleClientFactory` 的现场打包）就写在它的 spec 里。
- 浏览器半测试用文件头 `// @vitest-environment jsdom`（vitest 未开 globals，
  `@testing-library/react` 需在 spec 里显式 `cleanup`）。
- **测试描述行为，不描述实现**：行为变更必须连同测试一起改。
- **包特有的环境门控、装配辅助与判据在该包 `.agents/standards/`**：需要外部环境或平台的用例
  （数据库连接串、OS 能力）由该包写明触发方式与跳过条件，这里不复述——门控要有明确原因，
  不静默跳过、不为过验收放宽。

## 交付与发布

- **发布走 CI**：`.github/workflows/release.yml`（`main` 与 `next` 分支：`vendor prepare` → `dep` →
  `build` → `lint` → `test`（注入外部服务门控所需的环境变量）→ `build` → GitHub Packages publish）。
- **dist-tag 随版本号走**（[`scripts/publish-if-need.mts`](../../scripts/publish-if-need.mts)）：稳定版 →
  `latest`；`-alpha.*` → `alpha`；其余预发布（rc / beta / …）→ `next`。预发布绝不落在 `latest`。
- **本地私有包统一 `@local/*` 前缀，既不发布、也不进发布清单**：构建时一律内联进产物
  （规则 [`isLocalPackage`](../../devpackages/devkit/src/cordis-host.ts)，devkit 预设与
  `dsh-desktopify` 的 tsdown 配置共用）；内联后运行时真要的第三方依赖按公开包声明在
  `dependencies`，否则消费方解析不到它们的原生二进制。
- **严禁本地私自 `pnpm publish`**（包括用 `--registry` 指向 GitHub Packages 的发布）。版本 bump
  提交后由 CI 发布；本地只构建验证。
- 改动收尾时 `just lint` 只要不引入**新**错误即可，必要时 `just fmt`。

## 失败怎么处理

- 相关检查失败就停下修掉，或说明阻塞点；不要推着「CI 可能会过」往下走。
- 看起来像环境问题的，先证明：记下确切命令、失败用例、平台差异，再判断是环境还是回归。
- 不要为了过验收放宽检查（降低阈值、跳过用例、缩小覆盖范围），也不要改断言来迁就实现。
