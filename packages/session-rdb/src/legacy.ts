// 旧格式（v0/v1）历史数据读取转换：RDB 行 → v0/v1 物理记录 → 上游迁移链 →
// v2 逻辑事件。RDB 写路径从不持久化 sourceEventSeqs（读取时重计算），且
// delta（assistant/chunk）落盘被过滤——v1→v2 迁移对无 chunk 引用的
// assistant/message 走「无 pending 直接 emit」路径，生成 stream: [] 的 v2 事件。

import type { SessionEvent, SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { EventRow, SessionRow } from "./backend.ts";

/** 重建 v0/v1 物理 header 记录（RDB 行 → 物理 JSON 对象）。 */
function physicalHeader(row: SessionRow): Record<string, unknown> {
  return {
    type: "session",
    version: row.fVersion,
    id: row.fSessionId,
    createdAt: row.fCreatedAt,
    ...(row.fCwd !== null ? { cwd: row.fCwd } : {}),
    ...(row.fParentSession !== null ? { parentSession: row.fParentSession } : {}),
    ...(row.fSeedLength !== null ? { seedLength: row.fSeedLength } : {}),
    ...(row.fOrigin !== null ? { origin: row.fOrigin } : {}),
    delegationDepth: row.fDelegationDepth ?? 0,
  };
}

/** 重建一条 v0/v1 物理事件记录（桥接行 + 事件行 → 物理 JSON 对象）。 */
function physicalEvent(row: EventRow): Record<string, unknown> {
  return {
    type: row.fType,
    seq: row.fSequence,
    time: row.fCreatedAt,
    data: JSON.parse(row.fData) as unknown,
    ...(row.fSurfaceOp !== null ? { surfaceOp: JSON.parse(row.fSurfaceOp) as unknown } : {}),
  };
}

/**
 * 把旧格式（v0/v1）行转换为 v2 逻辑事件与 header。
 * @param row - 会话行（f_version < 2）。
 * @param eventRows - 已扫描保留的桥接行（稠密 seq，torn tail 已剔除）。
 * @returns v2 逻辑 header、继承前缀长度与事件。
 * @throws 迁移链拒绝（格式损坏 / 无法迁移）时原样抛出。
 */
export function convertLegacyRows(
  row: SessionRow,
  eventRows: readonly EventRow[],
): { meta: SessionHeader; inheritedEventCount: number; events: SessionEvent[] } {
  const restore = sessionFormatCatalog.createRestore(physicalHeader(row), {
    recovery: "strict",
    validation: "transformed",
  });
  for (const eventRow of eventRows) {
    restore.decodeRow(physicalEvent(eventRow));
  }
  const artifact = restore.finish();
  return {
    meta: artifact.header as unknown as SessionHeader,
    inheritedEventCount: artifact.inheritedEventCount,
    events: artifact.events as unknown as SessionEvent[],
  };
}

/** 会话行是否携带旧格式（v0/v1）数据。 */
export function isLegacyVersion(version: number): boolean {
  return version < 2;
}

export type { SessionId };
