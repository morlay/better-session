// 测试支撑（跨包测试共享）：helpers / contract / coordinator-contract。
// 仅供 vitest 测试引用；不进入运行时 bundle。
export { EmptySettings } from "./testing/helpers.ts";
export type { ContractBackend } from "./testing/contract.ts";
export {
  appendLog,
  meta,
  oneTurnLog,
  runPersistenceContract,
} from "./testing/contract.ts";
export type { CoordinatorFixture } from "./testing/coordinator-contract.ts";
export { runCoordinatorContract } from "./testing/coordinator-contract.ts";
