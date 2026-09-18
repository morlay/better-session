---
name: dsh-plugin-review
description: 审查某段改动（分支、PR、HEAD 到某个固定点的差异）时用——标准与规格双轴分开审，含坏味道基线与报告方式
disable-model-invocation: true
---

# 审查（review）

两个轴**分开跑、分开报**，互不掩盖：标准（是否符合本仓库记录的规范）、规格（是否忠实实现了发起它的设计
或需求）。一次改动可能过一个轴而败在另一个轴，合起来排序就会互相掩盖。

## 一、定固定点与规格来源

- 固定点由用户给（提交、分支、标签、`main`、`HEAD~5`…），没给就问。先确认可解析、差异非空：
  `git diff <fixed>...HEAD`（三点式，基于 merge-base）、`git log <fixed>..HEAD --oneline`。
- 规格来源按序找：提交信息里的引用 → 用户给的路径 → 与分支名或功能匹配的设计文档 / ADR（各层的
  `.agents/designs/` 与 `.agents/adrs/`）→ 问用户。没有规格就跳过规格轴并说明。
- 规格轴要回答三件事：规格要求但没做（或只做一半）、做了但没要求（范围蔓延）、做了但做法与规格不符。

## 二、标准来源

- [`AGENTS.md`](../../../AGENTS.md)：home 表、只读红线（上游 `@deepseek-ai/*`、`node_modules`）、发布纪律、
  `.agents/` 的分层规则；
- 被审改动**所属层**的 `.agents/standards/`：如何写 / 如何验证——**逐条对照**，本技能不复制其中条目；
- 各层 `.agents/adrs/`：既有决策——与 ADR 冲突按设计讨论处理，不是自动否决；
- 包内 `README.md` 与 `.agents/CONTEXT.md`：该包的用法与词汇（边界在
  [`.agents/CONTEXT-MAP.md`](../../CONTEXT-MAP.md)）；
- [`dsh-plugin-upstream-sync`](../dsh-plugin-upstream-sync/SKILL.md)：上游只读边界、扩展面清单、本地 patch
  的登记要求——改动碰了 vendor / patch / 上游类型时按它判；
- 坏味道基线（[`references/smell-baseline.md`](./references/smell-baseline.md)）：仓库规范优先于基线，
  基线永远只是判断。

## 三、审查时特别看什么

通用关注点，具体判据以上面两处规范为准：

1. **意图与接口**：改动两侧的接口是否都追过——行为、错误、取消、所有权、回收。
2. **生命周期与并发**：cordis 插件的注册与 disposer、异步建立、回调、子进程；发布前的竞态、await
   期间的取消、回收是否静默。
3. **边界与所有权**：只读区是否被改（上游源码、`node_modules`）；依赖是否按用途声明（运行期契约面用
   `peerDependencies`、测试面用 `devDependencies`，且一律 `workspace:*`）；抽象是否只服务当前调用方
   （多出来的公开面就是多余扩展）。
4. **范围与必要性**：每个抽象、状态机、选项、兼容路径是否对应现行契约与真实调用方；规格没要求的东西
   是否被顺手加进来。
5. **测试强度**：断言是否会在预期回归时失败；是否验证外部可观察状态而非复述实现；是否踩了
   [`testing-antipatterns`](../dsh-plugin-implement/references/testing-antipatterns.md)。
6. **记录同步**：动了边界、契约或流程，对应 home 是否更新，且没有在别处重复定义；新增的本地 patch /
   EXCLUDE 是否按上游同步技能的登记要求记了原因。
7. **验证证据**：作者跑了哪条命令；跨包或配置类改动是否按证据矩阵跑了全量（`just test` / `just lint` /
   `just build`；碰了上游还要有 `just vendor …` 的结果）。

## 四、报告

每条给：缺陷、位置（文件 / hunk）、影响、证据；区分阻塞与建议；工具已强制的（格式、lint / type-aware
类型检查）不重复报；跳过仓库规范明确认可的写法。

最后分别给两个轴的发现数与**各轴内**最严重的一条——不要跨轴选出唯一结论，那正是分开审要防的。
