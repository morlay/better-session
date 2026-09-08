// 非当前格式（v0/v1/v2）历史数据读取转换：RDB 行 → 物理记录 → 上游迁移链 →
// 当前逻辑事件。RDB 写路径从不持久化 sourceEventSeqs（读取时重计算），且
// delta（assistant/chunk）落盘被过滤——v1→v2 迁移对无 chunk 引用的
// assistant/message 走「无 pending 直接 emit」路径，生成 stream: [] 的 v2 事件。

import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { EventRow, SessionRow } from "./backend.ts";
import { repairRequestHeaders, rowToMeta, scanRows } from "./log.ts";

/** 重建 v0/v1/v2 物理 header 记录（RDB 行 → 物理 JSON 对象）。 */
function physicalHeader(row: SessionRow): Record<string, unknown> {
  const common = {
    type: "session",
    version: row.fVersion,
    id: row.fSessionId,
    createdAt: row.fCreatedAt,
    ...(row.fCwd !== null ? { cwd: row.fCwd } : {}),
    ...(row.fParentSession !== null ? { parentSession: row.fParentSession } : {}),
    ...(row.fOrigin !== null ? { origin: row.fOrigin } : {}),
    delegationDepth: row.fDelegationDepth ?? 0,
  };
  // v0/v1 物理 header 用 seedLength 表达继承前缀；v2 起改用 isSeeded，
  // 前缀长度由 log 里的 session/end-seed 标记推导。
  return row.fVersion < 2
    ? { ...common, ...(row.fSeedLength !== null ? { seedLength: row.fSeedLength } : {}) }
    : { ...common, isSeeded: row.fSeedLength !== null };
}

/** 重建一条 v0/v1/v2 物理事件记录（桥接行 + 事件行 → 物理 JSON 对象）。 */
function physicalEvent(row: EventRow): Record<string, unknown> {
  const stored = JSON.parse(row.fData) as unknown;
  // 两种存储形状：当前写入器落完整事件信封（与 JSONL 每行同构），schema v2
  // 时代只落 data 部分。迁移链要的是 payload，故信封形状取 `data`。
  const full =
    typeof stored === "object" &&
    stored !== null &&
    !Array.isArray(stored) &&
    typeof (stored as Record<string, unknown>)["type"] === "string" &&
    "data" in (stored as Record<string, unknown>);
  return {
    type: row.fType,
    seq: row.fSequence,
    time: row.fCreatedAt,
    data: full ? (stored as Record<string, unknown>)["data"] : stored,
    ...(row.fSurfaceOp !== null ? { surfaceOp: JSON.parse(row.fSurfaceOp) as unknown } : {}),
  };
}

/**
 * 把非当前格式（v0/v1/v2）行转换为当前逻辑事件与 header。
 * @param row - 会话行（f_version < SESSION_FORMAT_VERSION）。
 * @param eventRows - 已扫描保留的桥接行（稠密 seq，torn tail 已剔除）。
 * @returns 当前逻辑 header、继承前缀长度与事件。
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

/** 会话行是否携带非当前格式（f_version < SESSION_FORMAT_VERSION）数据。 */
export function isLegacyVersion(version: number): boolean {
  return version < SESSION_FORMAT_VERSION;
}

/**
 * 迁移链拒绝后，把旧格式行直接当**当前格式**事件视图采用。
 *
 * 旧写入器只在建会话时落一次 header version，之后跟随上游演进继续追加
 * 事件——同一个 log 因此可能是混合世代（v0 时代的行 + 新版本字段），不是
 * 任何单一已发布格式，严格迁移链必然拒绝。这些行的数据形状（消息包装、
 * 类型名）已经是当前格式，只需 header 版本归一到当前、按稠密 seq 读取；
 * 事件数据的补全与 surface 修复由读取视图修复（repairReadView）负责。
 *
 * 调用方须在此之后执行 `validateStoredEvents`：真正属于旧格式的类型
 * （`assistant/chunk` / `compact/*` 等）仍会被 fail-loud 拒绝。
 *
 * @param row - 会话行（f_version < SESSION_FORMAT_VERSION）。
 * @param eventRows - 该会话全部桥接行（按 f_sequence 升序）。
 * @returns 当前格式 header（version 归一到 SESSION_FORMAT_VERSION）、收缩后的
 *   继承前缀长度、稠密事件与可选 torn tail 起点。
 * @throws scanRows 的已提交区损坏错误（seq gap / 不可解析行）。
 */
export function adoptLegacyRows(
  row: SessionRow,
  eventRows: readonly EventRow[],
): {
  meta: SessionHeader;
  inheritedEventCount: number;
  events: SessionEvent[];
  tornFrom?: number;
} {
  const { preserved, tornFrom } = scanRows(eventRows, 0);
  // 旧格式 request/header 归一为当前格式：v3 起 system prompt 由 surface 上的
  // system/message 承载，header 必须省略 system / 空 tools / 空 adapterDefaults
  // （上游事件校验 fail loud）。归一必须发生在调用方 `validateStoredEvents`
  // 之前，否则整个会话加载失败。
  repairRequestHeaders(preserved);
  return {
    meta: { ...rowToMeta(row), version: SESSION_FORMAT_VERSION },
    // 继承前缀不得超过事件数（历史 rewind 未收缩的损坏样式），上游 load 判损坏。
    inheritedEventCount: Math.min(row.fSeedLength ?? 0, preserved.length),
    events: preserved,
    ...(tornFrom !== undefined ? { tornFrom } : {}),
  };
}

export type { SessionId };
