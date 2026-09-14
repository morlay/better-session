// 测试支撑（跨包测试共享）：helpers / contract / coordinator-contract。
// 仅供 vitest 测试引用；不进入运行时 bundle。
export { EmptySettings } from "./testing/helpers.ts";
export type { ContractBackend } from "./testing/contract.ts";
export { appendLog, meta, oneTurnLog, runPersistenceContract } from "./testing/contract.ts";
export type { CoordinatorFixture } from "./testing/coordinator-contract.ts";
export { runCoordinatorContract } from "./testing/coordinator-contract.ts";
// rewind 落到 live 会话上的那一件事：截断内存 log 并重置派生 surface / 折叠
// 缓存。跨包测试要构造「rewind 之后」的会话态时用它，不必拉起 RDB 装配。
export { truncateLiveSession } from "./branch.ts";
