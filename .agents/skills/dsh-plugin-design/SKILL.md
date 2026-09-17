---
name: dsh-plugin-design
description: 设计新插件能力、改包边界、给概念命名、写设计文档/ADR/债务记录时用——深度与接缝词汇、领域建模做法、每类记录的 home 与判据、四份模板
disable-model-invocation: true
---

# 设计（design）

设计先于实现，产出是**决策与词汇**，不是代码。

## 一、谈接口用同一套词汇

- **模块 / 接口 / 实现**：接口是调用方正确使用它所需知道的一切（签名、不变量、顺序约束、错误模式、
  配置要求），不只是类型表面。别用「组件」「服务」「API」替代。
- **深度**：小接口后面的多行为。判据——**删掉这个模块**，复杂度是消失（它只是透传），还是在 N 个调用点
  重新出现（它物有所值）。
- **接缝**：行为可替换的位置。把接缝放在哪里本身是设计决策，与它后面放什么无关。
- **适配器**：接缝处的具体实现。**一个适配器 = 假想接缝，两个适配器 = 真接缝**——判据是「谁需要穿过它」。
- **杠杆效应 / 局部性**：调用方从深度得到的能力；维护方把变更、知识、验证集中在一处。
- **接口就是测试面**：调用方与测试穿同一个接缝。想越过接口去测，说明接口形状不对。

接口守三条：**接受依赖而不自己创建、返回结果而不产生副作用、表面尽量小**。

词汇来源是 `/codebase-design` 技能。本仓库现有的接缝（契约层 `ctx.sessionBranch`、编排层
`ctx.sessionEditor`、传输面 `/session-editor`、数据层 `ctx.sessionPersistence`、装配面
`cordis.patch.yml`、client bundle）在 [`.agents/standards/how-to-write.md`](../../standards/how-to-write.md)
的「接缝在哪」表；上游侧的扩展面（服务注册、上游抽象实现、事件合并、配置、settings 覆盖、client bundle、
不变量）与只读红线见 [`dsh-plugin-upstream-sync`](../dsh-plugin-upstream-sync/SKILL.md)。

## 二、领域建模在会话中做

- 术语冲突当场摊开：「术语表把 X 定义成 A，你说的是 B，哪个对？」
- 模糊词换规范词：「会话」是上游的 `Session`，还是我们的编辑目标？
- 用具体场景压测关系与边界；交叉核对代码：文档说 A、代码做 B → 停下来问清。
- 借上游的词先核对真源（`vendor/<name>/packages/**/src/` 与上游自带文档），别按发布包的 d.ts 猜语义。
- 词定了**立刻**写进对应上下文的 `.agents/CONTEXT.md`（归属与边界见
  [`.agents/CONTEXT-MAP.md`](../../CONTEXT-MAP.md)），不批量补。

## 三、产出记到哪个 home

一个事实只有一个 home：写之前先找它现在在哪，**找到就改那一份，找不到才新建**；别处要用就链接过去，
不复制、不换说法。home 表在 [`AGENTS.md`](../../../AGENTS.md)。

产出落在**改动所属那一层**的 `.agents/`（仓库根，或 `packages/<family>/<pkg>/`）；上下文按 family 分组，
边界见 [`.agents/CONTEXT-MAP.md`](../../CONTEXT-MAP.md)，各层现状与布局见 [`.agents/README.md`](../../README.md)。

| 你要表达的东西        | 写进                               | 判据                                               | 格式                                             |
| --------------------- | ---------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| 词是什么意思          | 该层 `.agents/CONTEXT.md`          | 两个以上包要用 → 根；否则归所属上下文              | [`templates/context.md`](./templates/context.md) |
| 设计与取舍            | 该层 `.agents/designs/`            | 跨包跨层，或改动现有边界                           | [`templates/design.md`](./templates/design.md)   |
| 难逆的决策与理由      | 该层 `.agents/adrs/`               | 难逆 + 脱离上下文会困惑 + 真有取舍，三条同时成立   | [`templates/adr.md`](./templates/adr.md)         |
| 已知且被接受的债      | 该层 `.agents/debts/`              | 明知不好先这样 + 有可判定的销账条件 + 有不修的理由 | [`templates/debt.md`](./templates/debt.md)       |
| 代码与包怎么写        | 该层 `.agents/standards/`          | —                                                  | 两处：如何写 / 如何验证                          |
| 包 / 应用的门面与用法 | 该包的 `README.md`                 | —                                                  | GitHub 惯例：一句话定位 + 用法 + 链接            |
| 怎么做（流程）        | 仓库根 `.agents/skills/*/SKILL.md` | —                                                  | frontmatter `name` + `description`（写清何时用） |

命名：`NNNN-标题.md`，编号在**各层目录内**唯一且**不复用**（删掉的编号作废）；designs 标题写主题、adr
标题写结论句、debts 标题写现象。小节名、段落名照模板，不另创。

引用：**同层**用短号 `ADR-NNNN`、`设计 NNNN`、`债务 NNNN`（本层编号可解析到唯一文件）；**跨层**一律给
相对链接。决策变了不改旧文件：新写一份，旧文件状态行指向新编号。

## 四、写文档的底线

- 结论放最前（摘要表 / 决定一句），事实给可核查定位（`路径:行号`、命令输出）。
- 不写实现流水账，不写评审历史，不复述代码，不做设计说明式注释。
- 设计改了**先改文档再改代码**；状态行留痕，废弃时指向取代者。
- README 只做门面：一句话定位、一段用法、其余链接到 home。超重的 README 是债务，记进同层
  `.agents/debts/`，不要就地扩写。
- 涉及上游行为的设计，事实基线引上游真源（`vendor/<name>/packages/**/src/`）与上游测试，不引发布包的 d.ts。
