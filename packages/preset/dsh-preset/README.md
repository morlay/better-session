# @morlay/dsh-preset

个人用 dsh profile bundle。包的实体是 `cordis.patch.yml` 与构建产出的 `dist/presets/`（bundle patch 由
`dsh.bundle.patch` 声明、profile 组合器经该字段解析）。

设计与取舍（禁用官方 roster 的理由、persona / reminder 的提示词分层、生成器机制）见
[设计 0001](./.agents/designs/0001-预设生成与装配.md)。

## 内容

| 文件                       | 作用                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cordis.patch.yml`         | bundle patch：禁用官方 preset、注册本包 preset 为默认、声明个人 `llm-pi-ai` route、覆盖沙箱规则、插入 `prompt-reminder` 行 |
| `tool/generate-presets.ts` | 从上游生成 preset 的模块 + tsdown hooks                                                                                    |
| `dist/presets/standard/`   | 构建产物：自定义 preset「标准模式」（由上游 `standard` 生成）                                                              |
| `dist/presets/ptc/`        | 构建产物：自定义 preset「PTC 模式」（由上游 `ptc` 生成）                                                                   |

## 装配

`agent-presets.roots` 需指向本包的 `dist/presets/`。因为该目录随包分发，位置只能在运行期解析，故用 `!!js`
表达式从 profile 的 `baseUrl` 起 `createRequire` 解析包路径（`ctx.baseUrl` 即 root include 所在目录 = profile
根）：

```yaml
- id: agent-presets
  config:
    default: standard
    includeShippedRoot: false
    roots:
      - path: !!js process.getBuiltinModule('node:path').join(
          process.getBuiltinModule('node:path').dirname(
          process.getBuiltinModule('node:module').createRequire(ctx.baseUrl)
          .resolve('@morlay/dsh-preset/package.json')),
          'dist/presets')
        trust: system
```

`trust: system` 与 shipped root 同级：preset 是一份完整 composition，授予的能力等价于 shell 访问，只应来自受控
的安装包。表达式细节（为什么用 `process.getBuiltinModule`、`--dump-config` 往返）见
[设计 0001](./.agents/designs/0001-预设生成与装配.md)。

**桌面形态**：桌面宿主把 `agent-presets.roots` 固定为 dsh 包内的
`node_modules/@deepseek-ai/dsh/config/agent-presets`（`system` root），上面的 `!!js` roots 在桌面 profile 里会被
覆盖，preset 列表因此为空。app 工作区改用 `dsh.desktop.agentPresets` 声明本包的 `dist/presets`，由
[dsh-desktopify](../../desktop/dsh-desktopify/README.md) 在 dev 项目与种子 profile 里把内容物化到该挂载点；
`includeShippedRoot: false` 两种形态共用。

## 生成与升级

产物由 tsdown 的 `build:done` hook 在每次 `pnpm build` 时生成。单独重生成（默认输出 `dist/presets`，可传目录）
——生成器没有单独的 npm script，直接跑脚本：

```sh
pnpm exec tsx packages/preset/dsh-preset/tool/generate-presets.ts [outDir]
```

上游升级流程：

1. 升级 `DEEPSEEK_HARNESS_VERSION` 并 sync/patch/build。
2. `pnpm --filter @morlay/dsh-preset run build`（build:done 会重新生成）
3. `pnpm exec vitest run packages/preset` 确认无 drift（含 reminder 插件的行为测试）。

## 维护注意

- `package.json` 的 `files` 必须含 `dist`（preset 在其中）与 `tool`，否则发布产物缺内容。
- `cordis.patch.yml` 插入的 `@morlay/dsh-prompt-reminder` 必须能被 **profile** 的依赖树解析：本 bundle 的
  `dependencies` 已声明（示例 app 只声明 `@morlay/dsh-preset`）；换工作区时要保证该包在 profile 依赖树里可达，
  否则该行加载失败、工具说明会留在系统提示词里。
- 沙箱装配（禁用官方两行 + 插入 `sandbox-local` 行 + 规则）全在本 bundle 的 patch 里，app 的
  `dsh.profile.bundles` 不需要额外列 `@morlay/dsh-sandbox-local`——后者自带的 bundle patch 供把它作为独立 bundle
  采用的部署使用，与本 bundle 同时上线会重复插入同一行。**本包的 `dependencies` 必须声明
  `@morlay/dsh-sandbox-local`**：插入行的 `name` 要能在 profile 的依赖树里解析（`nodeLinker: hoisted` 由本包的
  依赖把它带进去）。
- **提示词与规则变化要重启**：profile 在启动时装载，`system-prompt` 的 section 与 `access` 规则在插件构造时
  注册 / 解析。dev 模式重启 `just custom dev` / `just custom desktop`，打包形态需重新 `just custom bundle`
  （patch 随 seed 快照复制）。
- **dev 模式需要先构建**：`just custom dev` / `just custom desktop` / `just custom bundle` 都先跑
  `preset-build`（`pnpm --filter @morlay/dsh-preset run build`）。`dist/presets` 只在 build 时生成，源码树里没有，
  新克隆下直接起 profile 会找不到 preset。
