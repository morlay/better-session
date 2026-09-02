# 设计说明（总览）

本文件是 `@morlay/session-rdb` 设计文档的**入口**：坐标模型、核心不变量与
文档导航。各主题的详细设计分文件记录，使用方式见 [README](../README.md)。

## 仓库结构与依赖解析

本包位于 better-session monorepo 的 `packages/session-rdb/`，是三层
cordis plugin 的**实现层**：契约层 `@morlay/session-branch`（provider 抽象）→
本包（实现）→ 编排层 `@morlay/ui-conversation-message-actions`（完整 rewind/retry/fork 功能）。

```
packages/session-rdb/
├── cordis.patch.yml             # bundle 声明：dsh plugin 装配本插件
├── docs/                        # 本文档目录
│   ├── design.md                # 本文档：总览 + 坐标模型 + 导航
│   ├── schema.md                # 数据表设计
│   ├── write-path.md            # 写路径流程
│   ├── read-path.md             # 读路径流程
│   ├── branch.md                # 分支能力（forkFrom / rewind / timeline）
│   ├── legacy-clean.md          # 旧数据修复（clean & reload）
│   ├── concurrency.md           # 并发写入者检测
│   └── event-reconstruction.md  # 事件 id 关联与重建可行性分析
├── package.json                 # 包元数据；exports 指向 lib/ 产物
├── src/                         # 只 import 官方包（@deepseek-ai/*）与 @morlay/session-branch
│   ├── __tests__/               # vitest 测试（testing/ 为共享契约与辅助）
│   ├── branch.ts                # 分支 provider 实现（rewind / forkFrom / timeline）
│   └── …                        # entities / adapters / 后端实现
├── tool/pg/                     # PostgreSQL 测试实例（compose + justfile）
└── README.md
```

## 坐标模型（单一稠密坐标）

**核心不变量：写路径零转换（忠实存储原始事件），读取集中转换（有据可查）。**

- `t_session_events.f_sequence` 是**稠密持久化 seq**：瞬时事件
  （`assistant/chunk` 与 `ignorable` 事件）**不入库**，幸存事件按持久化计数
  压缩重编号，**连续递增、无空洞**。
- `t_session_events.f_original_seq` 记录**上游 seq**（事件产生时的 seq，含
  瞬时事件计数）——读取时构建 `f_original_seq → f_sequence` 映射，把
  `shadowedRange` / replace range 从上游坐标重映射到稠密坐标（映射是存储
  事实，无启发式）。
- `t_events` 是**全局事件实体**，`f_data` 存**完整原始 data**（含
  `turn`/`step`、`shadowedRange` 原始坐标）——忠实存储，读取时按需 drop
  或重映射。不含任何 session 专属信息——一个事件行可被多个会话的桥接行
  引用（fork 派生会话复用父会话事件行，不复制）。
- session 专属信息（稠密 seq、上游 seq、surface 元数据 `surfaceOp`）全部在
  `t_session_events` 桥接行上；`sourceEventSeqs` 不落库，读取时按需重计算。

## 核心不变量（审计确认）

1. **写路径零转换**：事件内容、surfaceOp、shadowedRange 原样落库；坐标转换
   集中在读取路径（`f_original_seq` 映射是存储事实，无启发式）。
2. **上游 cursor ↔ 稠密 head**：首次 append 同起点（0）；load / adopt 重建
   seed 后上游 seq 与稠密 seq **恒等**（新 append 部分）——写读对齐的关键
   不变量（见 [write-path.md](write-path.md) / [read-path.md](read-path.md)）。
3. **fork 坐标自洽**：fork 前缀经 `inspect` 读取视图（replace range 已重映射
   到父稠密坐标），重编号后子会话坐标与父稠密坐标数值相同——无需额外坐标
   重映射；子会话 `f_original_seq` 是**子会话自己的上游空间**（不复制父值，
   避免两段空间重叠）（见 [branch.md](branch.md)）。
4. **rewind 保留区 range 完整性**：replace range 引用更早事件 ⇒ 截断尾部
   不破坏保留区 range（见 [branch.md](branch.md)）。
5. **合成 closers 内存合成**：崩溃尾部修复不落库，不违反忠实存储（见
   [read-path.md](read-path.md)）。
6. **SCHEMA_VERSION 门禁**：破坏性表结构变更必须 bump；表结构级升级走
   一次性迁移脚本，clean & reload 只处理同版本内数据格式差异（见
   [schema.md](schema.md) / [legacy-clean.md](legacy-clean.md)）。

## 文档导航

| 主题                                       | 文档                                               |
| ------------------------------------------ | -------------------------------------------------- |
| 数据表设计（元数据 / 事件实体 / 会话桥接） | [schema.md](schema.md)                             |
| 写路径流程（appendBatch）                  | [write-path.md](write-path.md)                     |
| 读路径流程（load / readFrom）              | [read-path.md](read-path.md)                       |
| 分支能力（forkFrom / rewind / timeline）   | [branch.md](branch.md)                             |
| 旧数据修复（clean & reload）               | [legacy-clean.md](legacy-clean.md)                 |
| 并发写入者检测                             | [concurrency.md](concurrency.md)                   |
| 事件 id 关联与重建可行性分析               | [event-reconstruction.md](event-reconstruction.md) |
