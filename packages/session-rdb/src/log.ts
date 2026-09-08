import type { SessionEvent, SessionHeader, SessionId, SurfaceOp } from "@deepseek-ai/dsh-session";
import type { SessionFormatEvent, SessionFormatHeader } from "@deepseek-ai/dsh-session-format";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import type { EventRow, SessionRow } from "./backend.ts";

export function rowToMeta(row: SessionRow): SessionHeader {
  if (!Number.isSafeInteger(row.fCreatedAt) || row.fCreatedAt < 0) {
    throw new Error("stored session createdAt must be a non-negative safe integer");
  }
  return {
    version: row.fVersion as SessionHeader["version"],
    id: row.fSessionId as SessionId,
    createdAt: row.fCreatedAt,
    ...(row.fCwd !== null ? { cwd: row.fCwd } : {}),
    ...(row.fParentSession !== null ? { parentSession: row.fParentSession as SessionId } : {}),
    isSeeded: row.fSeedLength !== null,
    ...(row.fOrigin !== null ? { origin: row.fOrigin as "subagent" } : {}),
    ...(row.fDelegationDepth === null ? {} : { delegationDepth: row.fDelegationDepth }),
  };
}

export function sessionInsertRow(
  storage: SessionStorageMetadata,
  incarnation: string,
): {
  fSessionId: string;
  fHeadEventId: string;
  fHeadSequence: number;
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fSeedLength: number | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;
  fIncarnation: string;
  fRevision: number;
} {
  const meta = storage.meta;
  return {
    fSessionId: meta.id,
    fHeadEventId: "",
    fHeadSequence: -1,
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fSeedLength: meta.isSeeded ? storage.inheritedEventCount : null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null,
    fIncarnation: incarnation,
    fRevision: 0,
  };
}

export function sessionConflictRow(storage: SessionStorageMetadata): {
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fSeedLength: number | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;
} {
  const meta = storage.meta;
  return {
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fSeedLength: meta.isSeeded ? storage.inheritedEventCount : null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null,
  };
}

export function rowToEvent(row: EventRow): SessionEvent {
  const surfaceOp = row.fSurfaceOp !== null ? (JSON.parse(row.fSurfaceOp) as SurfaceOp) : undefined;
  const record = JSON.parse(row.fData) as unknown;
  // fData 形状判别：新写入的完整事件（含 ignorable 信封，与 JSONL 每行
  // 同构）vs 旧 v2 库的纯 data 部分。完整事件必有 type/seq/time/data 四键。
  const full =
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    typeof (record as Record<string, unknown>)["type"] === "string" &&
    typeof (record as Record<string, unknown>)["seq"] === "number" &&
    typeof (record as Record<string, unknown>)["time"] === "number" &&
    "data" in (record as Record<string, unknown>);
  if (full) {
    // seq/time 以桥接行/事件列为权威（rewind 截断后仍稠密连续）；
    // surfaceOp 走桥接行列，sourceEventSeqs 不落库（读取时重计算）。
    return {
      ...(record as SessionEvent),
      seq: row.fSequence,
      time: row.fCreatedAt,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    } as SessionEvent;
  }
  return {
    type: row.fType as SessionEvent["type"],
    seq: row.fSequence,
    time: row.fCreatedAt,
    data: record as SessionEvent["data"],
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  } as SessionEvent;
}

const SURFACE_EVENT_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

const METERING_EVENT_TYPES = new Set(["compaction/summary", "compaction/prune"]);

/**
 * 读取时重计算 replace 的 sourceEventSeqs（sourceEventSeqs 不落库）。
 *
 * 优先采用紧邻 metering 事件（compaction/summary | compaction/prune）的
 * shadowedSeqs：它是压缩事务落库的**权威被遮蔽节点列表**（range 只是首尾
 * 边界对，压缩竞态下可能漏掉并发落地的节点——range 数值扫描会漏掉这些
 * 节点，使上游 assertProvenance 报 missing）。shadowedSeqs 已由 rowToEvent
 * 重映射到稠密坐标，与 replace 的 surfaceOp range 同空间。
 *
 * 无紧邻 metering 事件时回退到 range 数值扫描（历史数据 / 非压缩 replace，
 * 如 tool-result pruner 的旧样式），保证既有行为不变。
 */
export function recomputeReplaceProvenance(events: SessionEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const raw = event as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: number[] };
    const op = raw.surfaceOp;
    if (typeof op !== "object" || op === null || (op as { op?: string }).op !== "replace") {
      continue;
    }
    const { start, end } = op as { start: number; end: number };
    const metering = i > 0 ? events[i - 1] : undefined;
    const meteringData =
      metering !== undefined && METERING_EVENT_TYPES.has(metering.type)
        ? (metering.data as unknown as { shadowedSeqs?: number[] })
        : undefined;
    if (meteringData?.shadowedSeqs !== undefined) {
      raw.sourceEventSeqs = meteringData.shadowedSeqs;
      continue;
    }
    const refs: number[] = [];
    for (const candidate of events) {
      if (
        candidate.seq >= start &&
        candidate.seq <= end &&
        SURFACE_EVENT_TYPES.has(candidate.type)
      ) {
        refs.push(candidate.seq);
      }
    }
    raw.sourceEventSeqs = refs;
  }
}

function isEventSeqLike(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function isDeepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => isDeepEqualJson(item, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bRecord = b as Record<string, unknown>;
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(bRecord, key) &&
      isDeepEqualJson((a as Record<string, unknown>)[key], bRecord[key]),
  );
}

function toolResultRewriteContentOnly(original: SessionEvent, replacement: SessionEvent): boolean {
  const originalData = original.data as Record<string, unknown>;
  const replacementData = replacement.data as Record<string, unknown>;
  const originalMessage = originalData["message"] as { content?: unknown } | undefined;
  const replacementMessage = replacementData["message"] as { content?: unknown } | undefined;
  const originalContent = Array.isArray(originalMessage?.content)
    ? originalMessage.content
    : undefined;
  const replacementContent = Array.isArray(replacementMessage?.content)
    ? replacementMessage.content
    : undefined;
  if (originalContent === undefined || replacementContent === undefined) return false;
  const originalRest = {
    ...originalData,
    message: {
      ...originalMessage,
      content: [{ ...(originalContent[0] as Record<string, unknown>), content: null }],
    },
  };
  const replacementRest = {
    ...replacementData,
    message: {
      ...replacementMessage,
      content: [{ ...(replacementContent[0] as Record<string, unknown>), content: null }],
    },
  };
  return isDeepEqualJson(originalRest, replacementRest);
}

export function findSurfaceRepairs(events: readonly SessionEvent[]): {
  degradeToAppend: Set<number>;
  addAppendMarker: Set<number>;
  clearSurfaceOp: Set<number>;
} {
  const nodes: number[] = [];
  const degradeToAppend = new Set<number>();
  const addAppendMarker = new Set<number>();
  const clearSurfaceOp = new Set<number>();
  for (const event of events) {
    const raw = event as SessionEvent & { surfaceOp?: unknown };
    const op = raw.surfaceOp;
    if (op === undefined) {
      if (SURFACE_EVENT_TYPES.has(event.type)) {
        addAppendMarker.add(event.seq);
        nodes.push(event.seq);
      }
      continue;
    }
    if (op === "append") {
      if (SURFACE_EVENT_TYPES.has(event.type)) nodes.push(event.seq);
      else clearSurfaceOp.add(event.seq);
      continue;
    }
    if (!SURFACE_EVENT_TYPES.has(event.type)) {
      clearSurfaceOp.add(event.seq);
      continue;
    }
    const replace =
      typeof op === "object" && op !== null && !Array.isArray(op)
        ? (op as Record<string, unknown>)
        : undefined;
    const start = replace?.["start"];
    const end = replace?.["end"];
    const shapeOk =
      replace !== undefined &&
      replace["op"] === "replace" &&
      isEventSeqLike(start) &&
      isEventSeqLike(end);
    const startIdx = shapeOk ? nodes.indexOf(start as number) : -1;
    const endIdx = shapeOk ? nodes.indexOf(end as number) : -1;
    const rangeOk = shapeOk && startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx;
    let rewriteOk = true;
    if (rangeOk && event.type === "tool/result") {
      const shadowed = nodes.slice(startIdx, endIdx + 1);
      if (shadowed.length !== 1) {
        rewriteOk = false;
      } else {
        const original = events[shadowed[0]!];
        rewriteOk =
          original?.type === "tool/result" && toolResultRewriteContentOnly(original, event);
      }
    }
    if (!rangeOk || !rewriteOk) {
      degradeToAppend.add(event.seq);
      nodes.push(event.seq);
      continue;
    }
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
  }
  return { degradeToAppend, addAppendMarker, clearSurfaceOp };
}

export function repairSurfaceOps(events: SessionEvent[]): void {
  const repairs = findSurfaceRepairs(events);
  if (
    repairs.degradeToAppend.size === 0 &&
    repairs.addAppendMarker.size === 0 &&
    repairs.clearSurfaceOp.size === 0
  ) {
    return;
  }
  for (const event of events) {
    const raw = event as SessionEvent & { surfaceOp?: unknown };
    if (repairs.degradeToAppend.has(event.seq)) {
      raw.surfaceOp = "append";
    } else if (repairs.addAppendMarker.has(event.seq)) {
      raw.surfaceOp = "append";
    } else if (repairs.clearSurfaceOp.has(event.seq)) {
      delete raw.surfaceOp;
    }
  }
}

interface InboxSpliceLike {
  target?: unknown;
  start?: unknown;
  removedCount?: unknown;
  inserted?: Array<{ id?: unknown }>;
}

/**
 * 定位无法从空状态增量重放的 agent/inbox/spliced 事件（孤儿操作）。
 *
 * 上游 Inbox 每次构造都从会话起点重放全部 inbox splice，失败即拒绝整个
 * 会话（resume / 编辑重放不可用）。rewind 截断历史轮次后若残留 splice 引用
 * 已被截断的排队消息（插入被删、消费保留，或反之），重放时越界或重复——
 * 无法独立重放。
 */
export function orphanInboxSpliceSeqs(events: readonly SessionEvent[]): Set<number> {
  const inbox: Record<string, Array<{ id: string }>> = { "next-turn": [], "next-step": [] };
  const orphan = new Set<number>();
  for (const raw of events) {
    // agent/inbox/spliced 属 dsh-agent 类型扩展，不在本包 SessionEventMap——
    // 用宽类型 duck-type 读取，避免判别联合窄化到 never。
    const event = raw as unknown as { type: string; seq: number; data: InboxSpliceLike };
    if (event.type !== "agent/inbox/spliced") continue;
    const { target, start, removedCount, inserted } = event.data;
    const list = typeof target === "string" ? inbox[target] : undefined;
    if (list === undefined) {
      orphan.add(event.seq);
      continue;
    }
    const removed = removedCount ?? 0;
    const parsedInserted = (inserted ?? []).map((m) => ({
      id: typeof m.id === "string" ? m.id : "",
    }));
    if (
      !Number.isSafeInteger(start as number) ||
      (start as number) < 0 ||
      (start as number) > list.length ||
      !Number.isSafeInteger(removed as number) ||
      (removed as number) < 0 ||
      (start as number) + (removed as number) > list.length
    ) {
      orphan.add(event.seq);
      continue;
    }
    const candidate = [
      ...list.slice(0, start as number),
      ...parsedInserted,
      ...list.slice((start as number) + (removed as number)),
    ];
    const other = (target === "next-turn" ? inbox["next-step"] : inbox["next-turn"]) ?? [];
    const seen = new Set<string>();
    let dup = false;
    for (const m of [...candidate, ...other]) {
      if (m.id === "") continue;
      if (seen.has(m.id)) {
        dup = true;
        break;
      }
      seen.add(m.id);
    }
    if (dup) {
      orphan.add(event.seq);
      continue;
    }
    list.splice(start as number, removed as number, ...parsedInserted);
  }
  return orphan;
}

/** 内存修复：把孤儿 inbox splice 改写为 no-op（调用方负责持久化）。 */
export function repairOrphanInboxSplices(events: SessionEvent[]): void {
  const orphan = orphanInboxSpliceSeqs(events);
  if (orphan.size === 0) return;
  for (const event of events) {
    if (!orphan.has(event.seq)) continue;
    const data = event.data as unknown as InboxSpliceLike;
    const target = data.target;
    (event as { data: unknown }).data = {
      ...(typeof target === "string" ? { target } : { target: "next-turn" }),
      start: 0,
      removedCount: 0,
      inserted: [],
    };
  }
}

export function scanRows(
  rows: readonly EventRow[],
  base = 0,
): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1：解析每行 data；JSON 非法的行是洞（seq/type 列即使在 data 损坏
  // 时也存在）。
  interface Parsed {
    ok: boolean;
    event?: SessionEvent;
  }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row) };
    } catch {
      return { ok: false };
    }
  });

  // 最后一个合法 turn/end 的索引——洞在闭合轮内一律是已提交损坏。
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.fType === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }

  // 保留连续前缀（含完整的中断轮）；最后一个已提交边界之前的洞抛错，
  // 之后的洞停止（torn tail）。
  const preserved: SessionEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i];
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: unparsable committed event at seq ${rows[i]?.fSequence}`,
        );
      break; // 最后一个 turn/end 之后的 torn tail 片段——停止、容忍
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`,
        );
      break; // 最后一个 turn/end 之后的 seq 空洞——torn tail，停止
    }
    preserved.push(p.event);
  }

  // 保留前缀之外的行是未提交的 torn tail；其首个 seq 是物理删除起点。
  return preserved.length < rows.length
    ? { preserved, tornFrom: base + preserved.length }
    : { preserved };
}

export function toJsonlArtifact(
  meta: SessionHeader,
  inheritedEventCount: number,
  events: readonly SessionEvent[],
): string {
  const header = sessionFormatCatalog.encodeCurrentHeader(
    {
      ...meta,
      delegationDepth: meta.delegationDepth ?? 0,
    } as unknown as SessionFormatHeader,
    inheritedEventCount,
  );
  const lines = [JSON.stringify(header)];
  for (const event of events) {
    lines.push(
      JSON.stringify(
        sessionFormatCatalog.encodeCurrentEvent(event as unknown as SessionFormatEvent),
      ),
    );
  }
  return lines.join("\n");
}
