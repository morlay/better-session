---
name: dsh-side-workspace-plugin-develop
description: 以 side workspace 形态基于上游 deepseek-harness（dsh）开发插件集合并跟随上游演进。使用时机：从零搭建（workspace 对齐与初始化）、同步上游到指定提交（DEEPSEEK_HARNESS_VERSION / REVISION）、EXCLUDE 裁剪与本地 patch、构建完整上游、升级与适配评估、排查上游行为。
---

# 基于上游 deepseek-harness 的插件集合开发流程

以 side workspace 形态开发 cordis 插件集合：上游以完整 git 仓库 vendor 到
`vendor/<name>/`（保留 `.git`），经 git 同步锁定到指定提交，构建完整上游；
插件包以 `workspace:^` 引用其源码。背景与取舍见 [RATIONALE.md](./RATIONALE.md)。

```
<your-repo>/
├── vendor/<upstream>/       # 上游完整 git clone（保留 .git）
├── packages/<plugin-pkg>/   # 插件包（workspace:^ 引用上游，见扩展面清单）
├── patches/                 # steps.json + *.patch（被脚本读取，仓库维护）
├── pnpm-workspace.yaml      # 对齐上游 + 三个 workspace 配置（见初始化）
└── 版本变量配置               # 如 mise.toml：DEEPSEEK_HARNESS_*
```

skill 自带脚本 `scripts/{sync,patch,build}.ts`，用 **`tsx` 执行**，勿用 `pnpm exec`——node_modules 缺失时会触发隐式 install，下载
已裁剪依赖）：

| env                                                   | 含义                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `DEEPSEEK_HARNESS_DIR`                                | 上游目录，**相对 workspace 根**（pnpm-workspace.yaml 所在目录） |
| `DEEPSEEK_HARNESS_VERSION`                            | 目标版本（tag `dsh-v{version}` 优先，回退同名 branch）          |
| `DEEPSEEK_HARNESS_REVISION`                           | 可选，特定 commit / 短 sha，**优先于 VERSION**                  |
| `DEEPSEEK_HARNESS_EXCLUDE`                            | 可选，逗号分隔待裁剪包目录完整相对路径（相对上游根）            |
| `DEEPSEEK_HARNESS_REPO` / `DEEPSEEK_HARNESS_NO_CLEAN` | 可选                                                            |

## 初始化：对齐 workspace（一次性）

1. **完整 clone 上游**（保留 .git）：

   ```sh
   git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
   ```

2. **`pnpm-workspace.yaml` 对齐**：参考上游自己的 pnpm-workspace.yaml，把
   其成员目录以 `vendor/<name>/` 为前缀映射进 `packages` globs，再附本仓库
   目录（对齐不全 → 部分上游包从 registry 解析，出现双副本）。

3. **三个配置必须为 true**（不能与上游默认一致——它们是本仓库跨 vendor
   源码引用得以成立的开关）：

   ```yaml
   linkWorkspacePackages: true
   hoistWorkspacePackages: true
   autoInstallPeers: true
   ```

   - `linkWorkspacePackages`：workspace 内互引一律链接——`@deepseek-ai/*`
     全仓库唯一一份上游源码；否则上游包从 registry 解析成发布副本，与源码
     并存 → 同名 branded 类型 / 枚举双份，tsc 下互不兼容（类型唯一性破坏）。
   - `hoistWorkspacePackages` + `autoInstallPeers`：peer 依赖（如
     `@deepseek-ai/cordis`）自动安装并提升到根——各插件包无需为每个上游包
     重复声明 devDeps。

4. **根安装一次**：`pnpm install`。此后日常依赖变更才需再次根安装。

5. **插件包依赖声明**：对上游 `@deepseek-ai/*` 一律用 **`workspace:^`**
   版本（不用 registry 版本号 / `latest`）——保证解析到 vendor 源码而非
   发布副本。按用途放对位置：

   ```jsonc
   {
     "peerDependencies": { "@deepseek-ai/dsh-session": "workspace:^" }, // 契约面：插件 import 的上游类型/服务
     "devDependencies": { "@deepseek-ai/dsh-token-meter": "workspace:^" }, // 测试面：仅测试装配用
   }
   ```

   - **peerDependencies**：插件运行期 import 的上游包（类型 / 服务契约）；
     消费方（最终装配方）负责解析，插件自身不装副本。
   - **devDependencies**：仅测试 / 装配辅助用（如 mock 服务、投影注册表）；
     不进入运行期依赖。
   - 插件包**不依赖上游构建脚本**（不 import 其 `lib/` 路径之外的产物）。

## 同步流程

完整同步 = sync → patch → build（**同步链不需要根目录 `pnpm install`**；
build 内含干净 install）。顺序固定：

```sh
tsx <skill 路径>/scripts/sync.ts    # 1. 对齐到目标提交
tsx <skill 路径>/scripts/patch.ts   # 2. EXCLUDE 裁剪 + steps.json 补丁
tsx <skill 路径>/scripts/build.ts   # 3. 干净构建
```

### sync.ts：同步上游到指定提交

- 目录缺失 → 首次完整 clone；存在 → `git fetch --prune`（增量）+
  `git reset --hard` + 检出目标。
- 检出优先级：`REVISION` > `VERSION`（tag → branch）；检出到本地
  `sync/<target>` 分支。fetch 完整 refs，revision 可指向任意提交。
- **目标相同也 reset**——清旧 patch 残留，保证 repatch 干净基线。
- sync 后**必须** patch（repatch）再 build；升级前记旧 HEAD
  （`git -C <dir> log -1`），升级后 `git diff` / `git log` 对比。

### patch.ts：裁剪与补丁

1. **EXCLUDE 裁剪**：对 `DEEPSEEK_HARNESS_EXCLUDE` 每项删目录 + 从全部
   `tsconfig*.json` 移除其 path 引用行；目录不存在时 warn 跳过。
2. **steps.json 步骤清单**（默认 `<workspace 根>/patches/steps.json`）：

   ```jsonc
   [
     { "type": "rm", "path": "…" },
     { "type": "text", "file": "…", "pattern": "…", "flags": "gm", "to": "" },
     { "type": "git", "patch": "…" },
   ]
   ```

   **任一步骤失败即失败**——上游已变化，评估更新 / 删除 / 新增，不跳过。

> 裁剪或改补丁后，若 lockfile 仍固化被裁依赖，需重新生成 lockfile
> （`pnpm install --lockfile-only`）——否则后续 install 仍会下载。

### build.ts：干净构建

上游目录内 `pnpm install && pnpm run build`（上游自带 lockfile），默认清理
其 node_modules（`DEEPSEEK_HARNESS_NO_CLEAN=1` 保留）。验证 `lib/` 产物
存在。

> 仓库可封装为命令（如 just：`vendor sync` / `vendor patch` / `vendor
build`），直接 `tsx` 调用脚本，语义与流程一致。

## 升级

1. 改 `DEEPSEEK_HARNESS_VERSION`（或 `DEEPSEEK_HARNESS_REVISION`）。
2. 记旧 HEAD。
3. sync → patch（失效即信号）→ build。
4. 门禁（本仓库）：test / lint / build，与 CI 一致。
5. **适配评估（必做）**：对照「cordis 扩展面清单」逐面核对变化；结论记录
   为决策文档或变更日志；行为变更连同测试一起改。

## 插件开发：cordis 扩展面清单

上游代码不可修改，扩展走 cordis 插件层。按扩展面组织插件：

| 扩展面        | 机制                                          | 适配检查点                               |
| ------------- | --------------------------------------------- | ---------------------------------------- |
| 服务注册      | `Service` 子类 + `ctx.inject`                 | 服务键唯一；可选服务用 `ctx.get(name)`   |
| 上游抽象实现  | 实现上游接口（如 `PersistenceBackend`）再注册 | 原语签名 / 标记语义 / 事务模式随版本演进 |
| 事件合并      | `declare module` 扩展 `SessionEventMap`       | 结构化守卫；`ignorable: true` 信封语义   |
| 配置          | `Config` schema（schemastery）                | schema 与 settings namespace 一致        |
| 用户覆盖      | settings namespace                            | `installSection` 钩子；纯 YAML 无 `!!js` |
| 运行时协调    | 读取 / 同步上游服务内部状态                   | 私有字段名与语义是升级时最脆弱的面       |
| client bundle | 手递单文件替换上游渲染                        | 单文件约束、external 边界                |
| 不变量        | `./invariant`（仅观察可发散时）               | 注册命名、disposer                       |

## 排查上游行为

1. 源码即真源：`vendor/<name>/packages/<group>/<pkg>/src/`。
2. 上游测试是契约活文档：`vendor/<name>/packages/<pkg>/tests/`。
3. 上游自带约定文档优先于猜测。
4. 排查结论影响插件决策则记录（ADR / 变更日志）。

## 本地 patch 管理

1. **最小必要**：能走配置 / 插件层 / settings 解决的不打 patch；整包裁剪
   优先用 `DEEPSEEK_HARNESS_EXCLUDE`。
2. **集中登记**：EXCLUDE 值在环境配置登记；steps.json 集中 `patches/`，
   每项记录为什么（上游缺陷 / 构建约束 / 裁剪需求）。
3. **升级时评估失效**：`git apply` 失败即信号，评估删除 / 更新 / 保留。

## 验证与发布

- 契约测试若有外部依赖（如 PostgreSQL）：本地缺环境自动跳过、CI 提供
  service——先本地跑无依赖面，再在 CI 确认全量。
- **发布走 CI**：严禁本地私自 publish。版本 bump 提交后由 CI 构建 + 发布；
  本地只构建验证。
