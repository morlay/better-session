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
│   ├── legacy-clean.md          # 旧数据修复（读取/导出视图修复）
│   ├── concurrency.md           # 并发写入者检测
│   ├── event-reconstruction.md  # 事件 id 关联与重建可行性分析
│   └── adr/                     # 决策记录（0009：storages 接管到 rdb 语义表）
├── package.json                 # 包元数据；exports 开发指 src、发布指 dist
├── src/                         # 依赖：官方包（@deepseek-ai/*）、@morlay/session-branch、drizzle-orm / pg 等
│   ├── __tests__/               # vitest 测试
│   ├── testing/                 # 跨包共享的测试契约与辅助（./testing 导出）
│   ├── branch.ts                # 分支 provider 实现（rewind / forkFrom / timeline）
│   ├── storage-takeover/        # storages 接管：workspace KV 后端 + 投影缓存服务
│   └── …                        # entities / adapters / 后端实现
├── tool/pg/                     # PostgreSQL 测试实例（compose + justfile）
└── README.md
```

## 坐标模型（单一稠密坐标）

**核心不变量：写路径零转换（忠实存储原始事件），读取集中转换（有据可查）。**

- `t_session_events.f_sequence` 是**稠密持久化 seq**：事件原样落库（与上游
  JSONL 一致，无过滤无重编号），**连续递增、无空洞**。
- `t_events` 是**全局事件实体**，`f_data` 存**完整事件**（type/seq/time/data/
  ignorable 信封，与 JSONL 每行同构）——忠实存储，读回时整体解析。不含任何
  session 专属信息——一个事件行可被多个会话的桥接行引用（fork 派生会话复用
  父会话事件行，不复制）。
- session 专属信息（稠密 seq、surface 元数据 `surfaceOp`）全部在
  `t_session_events` 桥接行上；`sourceEventSeqs` 不落库，读取时按需重计算。

## 核心不变量（审计确认）

1. **写路径零转换**：事件内容、surfaceOp 原样落库；写路径当前格式校验
   （`validateStoredEvents`）只拒绝未知类型（非 ignorable）与非法消息形状，
   不做坐标转换。
2. **上游 seq 与稠密 seq 恒等**：原样存储下事件 seq 即稠密 seq，写读天然
   对齐——无需坐标映射（见 [write-path.md](write-path.md) /
   [read-path.md](read-path.md)）。
3. **fork 坐标自洽**：fork 前缀经 `readLog` 读取视图（replace range 已是稠密
   坐标），重编号后子会话坐标与父稠密坐标数值相同——无需额外坐标重映射；
   子会话桥接行 `f_sequence` 是**子会话自己的上游空间**（不复制父值，避免
   两段空间重叠）（见 [branch.md](branch.md)）。
4. **rewind 保留区 range 完整性**：replace range 引用更早事件 ⇒ 截断尾部
   不破坏保留区 range（见 [branch.md](branch.md)）。
5. **SCHEMA_VERSION 门禁**：破坏性表结构变更必须 bump；表结构级升级走
   drizzle-kit 生成的迁移（`drizzle/` 目录，运行时 drizzle `migrate()` 执行），
   同版本内数据格式差异（含 surface 语义损坏）在读取/导出视图修复（不落库，
   见 [read-path.md](read-path.md) / [legacy-clean.md](legacy-clean.md)）。

## 文档导航

| 主题                                       | 文档                                               |
| ------------------------------------------ | -------------------------------------------------- |
| 数据表设计（元数据 / 事件实体 / 会话桥接） | [schema.md](schema.md)                             |
| 写路径流程（appendBatch）                  | [write-path.md](write-path.md)                     |
| 读路径流程（load / readFrom）              | [read-path.md](read-path.md)                       |
| 分支能力（forkFrom / rewind / timeline）   | [branch.md](branch.md)                             |
| 旧数据修复（读取/导出视图修复）            | [legacy-clean.md](legacy-clean.md)                 |
| 并发写入者检测                             | [concurrency.md](concurrency.md)                   |
| 事件 id 关联与重建可行性分析               | [event-reconstruction.md](event-reconstruction.md) |
