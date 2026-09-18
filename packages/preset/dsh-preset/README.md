# @morlay/dsh-preset

个人用 dsh profile bundle。包的实体是 `cordis.patch.yml` 与构建产出的 `dist/presets/`（bundle patch 由
`dsh.bundle.patch` 声明、profile 组合器经该字段解析）。

设计与取舍（禁用官方 roster 的理由、persona / reminder 的提示词分层、生成器机制、patch 层级与放置）见
[设计 预设生成与装配](./.agents/designs/20260917-预设生成与装配.md)。

## 内容

| 文件                       | 作用                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cordis.patch.yml`         | bundle patch：禁用官方 preset、注册本包 preset 为默认、声明个人 `llm-pi-ai` route、覆盖沙箱规则、插入 `prompt-reminder` 行 |
| `tool/generate-presets.ts` | 从上游生成 preset 的模块 + tsdown hooks                                                                                    |
| `dist/presets/standard/`   | 构建产物：自定义 preset「标准模式」（由上游 `standard` 生成）                                                              |
| `dist/presets/ptc/`        | 构建产物：自定义 preset「PTC 模式」（由上游 `ptc` 生成）                                                                   |

## 装配

`agent-presets` 行把 `roots` 指向本包的 `dist/presets/`（`default: standard`、
`includeShippedRoot: false`、`trust: system`）。该目录随包分发，位置只能在运行期解析，
因此用 `!!js` 表达式从 profile 的 `baseUrl` 起 `createRequire` 解析包路径——表达式本体
与行内容见 `cordis.patch.yml`，机制与理由见
[设计 预设生成与装配](./.agents/designs/20260917-预设生成与装配.md)。

**桌面形态**：桌面宿主把 `agent-presets.roots` 固定为 dsh 包内的 `config/agent-presets`
挂载点（`system` root），上面的 `!!js` roots 在桌面 profile 里被覆盖。app 工作区改用
`dsh.desktop.agentPresets` 声明本包的 `dist/presets`，由
[dsh-desktopify](../../desktop/dsh-desktopify/README.md) 在 dev 项目与种子 profile 里把内容
物化到该挂载点。

## 生成与升级

产物由 tsdown 的 `build:done` hook 在每次 `pnpm build` 时生成。单独重生成（默认输出
`dist/presets`，可传目录）——生成器没有单独的 npm script，直接跑脚本：

```sh
pnpm exec tsx packages/preset/dsh-preset/tool/generate-presets.ts [outDir]
```

上游升级与适配流程见 [`dsh-plugin-upstream-sync` 技能](../../../.agents/skills/dsh-plugin-upstream-sync/SKILL.md)。

## 维护注意

- 本 bundle patch 插入的每一行，其 `name` 都必须能被 **profile 的依赖树**解析：本包
  `dependencies` 已声明 `@morlay/dsh-sandbox-local` / `@morlay/dsh-prompt-reminder` /
  `@morlay/dsh-reference-injection`，因此 app 的 **preset 相关**依赖只声明 `@morlay/dsh-preset`；
  换工作区时要保证这些包在依赖树里可达，否则对应装配行加载失败。
- **提示词与规则变化要重启**：profile 在启动时装载，`system-prompt` 的 section 与 `access`
  规则在插件构造时注册 / 解析。dev 模式重启 `just custom dev` / `just custom desktop`，打包形态
  需重新 `just custom bundle`（patch 随 seed 快照复制）。
- **dev 模式需要先构建**：`just custom dev` / `just custom desktop` / `just custom bundle` 都先跑
  `preset-build`（`pnpm --filter @morlay/dsh-preset run build`）。`dist/presets` 只在 build 时生成，
  源码树里没有，新克隆下直接起 profile 会找不到 preset。
- **发布产物**：`package.json` 的 `files` 必须含 `dist`（preset 在其中）与 `tool`，判据见
  [设计 预设生成与装配](./.agents/designs/20260917-预设生成与装配.md)。
