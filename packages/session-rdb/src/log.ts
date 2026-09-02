import type { SessionEvent, SessionHeader, SessionId, SurfaceOp } from "@deepseek-ai/dsh-session";
import { SessionSeq, encodeSeqRanges, packChunkRuns } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import type { EventRow, SessionRow } from "./backend.ts";

export function rowToMeta(row: SessionRow): SessionHeader {
  if (!Number.isSafeInteger(row.fCreatedAt) || row.fCreatedAt < 0) {
    throw new Error("stored session createdAt must be a non-negative safe integer");
  }
  return {
    version: row.fVersion,
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

export function remapSurfaceOp(op: SurfaceOp, remap: (seq: number) => number): SurfaceOp {
  if (op === "append") return op;
  return {
    op: "replace",
    start: SessionSeq(remap(op.start)),
    end: SessionSeq(remap(op.end)),
  };
}

export function remapShadowedRange(
  range: { start: number; end: number },
  remap: (seq: number) => number,
): { start: number; end: number } {
  return { start: remap(range.start), end: remap(range.end) };
}

export function rowToEvent(row: EventRow, seqMap: ReadonlyMap<number, number>): SessionEvent {
  const remap = (seq: number): number => seqMap.get(seq) ?? seq;
  const surfaceOp =
    row.fSurfaceOp !== null
      ? remapSurfaceOp(JSON.parse(row.fSurfaceOp) as SurfaceOp, remap)
      : undefined;
  const data = JSON.parse(row.fData) as SessionEvent["data"];
  // compaction 事件的 shadowedRange 是插件合并字段，经结构化视图重映射。
  if (row.fType === "compaction/summary" || row.fType === "compaction/prune") {
    const metering = data as unknown as { shadowedRange?: { start: number; end: number } };
    if (metering.shadowedRange !== undefined) {
      metering.shadowedRange = remapShadowedRange(metering.shadowedRange, remap);
    }
  }
  return {
    type: row.fType as SessionEvent["type"],
    seq: row.fSequence,
    time: row.fCreatedAt,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  } as SessionEvent;
}

export function buildSeqMap(
  rows: readonly Pick<EventRow, "fSequence" | "fOriginalSeq">[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    if (!map.has(row.fOriginalSeq)) map.set(row.fOriginalSeq, row.fSequence);
  }
  return map;
}

const SURFACE_EVENT_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

export function recomputeReplaceProvenance(events: SessionEvent[]): void {
  for (const event of events) {
    const raw = event as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: number[] };
    const op = raw.surfaceOp;
    if (typeof op !== "object" || op === null || (op as { op?: string }).op !== "replace") {
      continue;
    }
    const { start, end } = op as { start: number; end: number };
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

export function scanRows(
  rows: readonly EventRow[],
  base = 0,
  seqMap: ReadonlyMap<number, number> = new Map(),
): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1：解析每行 data；JSON 非法的行是洞（seq/type 列即使在 data 损坏
  // 时也存在）。
  interface Parsed {
    ok: boolean;
    event?: SessionEvent;
  }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row, seqMap) };
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

function toStorageRecord(record: import("@deepseek-ai/dsh-session").StorageRecord): unknown {
  const withSeqs = record as import("@deepseek-ai/dsh-session").StorageRecord & {
    sourceEventSeqs?: unknown;
  };
  if (withSeqs.sourceEventSeqs === undefined) return record;
  return { ...record, sourceEventSeqs: encodeSeqRanges(withSeqs.sourceEventSeqs as never) };
}

export function toJsonlArtifact(
  meta: SessionHeader,
  inheritedEventCount: number,
  events: readonly SessionEvent[],
): string {
  const header = {
    type: "session",
    version: meta.version,
    id: meta.id,
    createdAt: meta.createdAt,
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    ...(meta.parentSession === undefined ? {} : { parentSession: meta.parentSession }),
    ...(meta.isSeeded ? { seedLength: inheritedEventCount } : {}),
    ...(meta.origin === undefined ? {} : { origin: meta.origin }),
    delegationDepth: meta.delegationDepth ?? 0,
    ...(meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }),
  };
  const lines = [JSON.stringify(header)];
  for (const record of packChunkRuns(events)) lines.push(JSON.stringify(toStorageRecord(record)));
  return lines.join("\n");
}
