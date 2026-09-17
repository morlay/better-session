import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader, SessionId, SurfaceOp } from "@deepseek-ai/dsh-session";
import type { SessionFormatEvent, SessionFormatHeader } from "@deepseek-ai/dsh-session-format";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import type { EventRow, SessionRow } from "./backend.ts";

function normalizeSurfaceOp(value: unknown): SurfaceOp {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value as SurfaceOp;
  }
  const record = value as Record<string, unknown>;
  if (record["op"] !== "replace") return value as SurfaceOp;
  const startSeq = record["startSeq"] ?? record["start"];
  const endSeq = record["endSeq"] ?? record["end"];
  if (typeof startSeq !== "number" || typeof endSeq !== "number") return value as SurfaceOp;
  return { op: "replace", startSeq: SessionSeq(startSeq), endSeq: SessionSeq(endSeq) };
}

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
  const surfaceOp =
    row.fSurfaceOp !== null ? normalizeSurfaceOp(JSON.parse(row.fSurfaceOp) as unknown) : undefined;
  const record = JSON.parse(row.fData) as unknown;

  const full =
    typeof record === "object" &&
    record !== null &&
    !Array.isArray(record) &&
    typeof (record as Record<string, unknown>)["type"] === "string" &&
    typeof (record as Record<string, unknown>)["seq"] === "number" &&
    typeof (record as Record<string, unknown>)["time"] === "number" &&
    "data" in (record as Record<string, unknown>);
  if (full) {
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

const SURFACE_EVENT_TYPES = new Set([
  "system/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

const METERING_EVENT_TYPES = new Set(["compaction/summary", "compaction/prune"]);

export function recomputeReplaceProvenance(events: SessionEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const raw = event as unknown as { surfaceOp?: unknown; sourceEventSeqs?: number[] };
    const op = raw.surfaceOp;
    if (typeof op !== "object" || op === null || (op as { op?: string }).op !== "replace") {
      continue;
    }
    const { startSeq, endSeq } = op as { startSeq: number; endSeq: number };
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
        candidate.seq >= startSeq &&
        candidate.seq <= endSeq &&
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
  clampEnd: Map<number, number>;
} {
  const nodes: number[] = [];
  const degradeToAppend = new Set<number>();
  const addAppendMarker = new Set<number>();
  const clearSurfaceOp = new Set<number>();
  const clampEnd = new Map<number, number>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
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
    const start = replace?.["startSeq"];
    const end = replace?.["endSeq"];
    const shapeOk =
      replace !== undefined &&
      replace["op"] === "replace" &&
      isEventSeqLike(start) &&
      isEventSeqLike(end);
    const startIdx = shapeOk ? nodes.indexOf(start as number) : -1;
    let endIdx = shapeOk ? nodes.indexOf(end as number) : -1;

    let clamped: number | undefined;
    if (shapeOk && startIdx !== -1 && endIdx === -1) {
      clamped = clampReplaceEnd(events, index, nodes, startIdx);
      if (clamped !== undefined) endIdx = nodes.indexOf(clamped);
    }
    const rangeOk = shapeOk && startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx;

    const provenanceOk = event.type !== "assistant/message";
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
    if (!rangeOk || !rewriteOk || !provenanceOk) {
      degradeToAppend.add(event.seq);
      nodes.push(event.seq);
      continue;
    }
    if (clamped !== undefined) clampEnd.set(event.seq, clamped);
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
  }
  return { degradeToAppend, addAppendMarker, clearSurfaceOp, clampEnd };
}

function clampReplaceEnd(
  events: readonly SessionEvent[],
  index: number,
  nodes: readonly number[],
  startIdx: number,
): number | undefined {
  const metering = index > 0 ? events[index - 1] : undefined;
  if (metering === undefined || !METERING_EVENT_TYPES.has(metering.type)) return undefined;
  const shadowedSeqs = (metering.data as unknown as { shadowedSeqs?: unknown }).shadowedSeqs;
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return undefined;
  return nodes[Math.min(startIdx + shadowedSeqs.length - 1, nodes.length - 1)];
}

export function repairSurfaceOps(events: SessionEvent[]): void {
  const repairs = findSurfaceRepairs(events);
  if (
    repairs.degradeToAppend.size === 0 &&
    repairs.addAppendMarker.size === 0 &&
    repairs.clearSurfaceOp.size === 0 &&
    repairs.clampEnd.size === 0
  ) {
    return;
  }
  for (const event of events) {
    const raw = event as SessionEvent & { surfaceOp?: unknown };
    const clamped = repairs.clampEnd.get(event.seq);
    if (repairs.degradeToAppend.has(event.seq)) {
      raw.surfaceOp = "append";
    } else if (clamped !== undefined) {
      const op = raw.surfaceOp as { startSeq: number };
      raw.surfaceOp = {
        op: "replace",
        startSeq: SessionSeq(op.startSeq),
        endSeq: SessionSeq(clamped),
      };
    } else if (repairs.addAppendMarker.has(event.seq)) {
      raw.surfaceOp = "append";
    } else if (repairs.clearSurfaceOp.has(event.seq)) {
      delete raw.surfaceOp;
    }
  }
}

export function repairAssistantSettlement(events: SessionEvent[]): void {
  for (const event of events) {
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    const data = event.data as unknown as Record<string, unknown>;
    if (!Array.isArray(data["stream"])) data["stream"] = [];
  }
}

export function repairRequestHeaders(events: SessionEvent[]): void {
  for (const event of events) {
    if (event.type !== "request/header") continue;
    const data = event.data as unknown as Record<string, unknown>;
    const header = data["header"];
    if (typeof header !== "object" || header === null || Array.isArray(header)) continue;
    const record = header as Record<string, unknown>;
    delete record["system"];
    if (Array.isArray(record["tools"]) && record["tools"].length === 0) delete record["tools"];
    const defaults = record["adapterDefaults"];
    if (
      typeof defaults === "object" &&
      defaults !== null &&
      !Array.isArray(defaults) &&
      Object.keys(defaults).length === 0
    ) {
      delete record["adapterDefaults"];
    }
  }
}

export function syncMeteringRanges(events: SessionEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    const metering = events[i - 1]!;
    if (!METERING_EVENT_TYPES.has(metering.type)) continue;
    const event = events[i]!;
    const op = (event as SessionEvent & { surfaceOp?: unknown }).surfaceOp;
    if (typeof op !== "object" || op === null || (op as { op?: string }).op !== "replace") continue;
    const { startSeq, endSeq } = op as { startSeq: number; endSeq: number };
    const data = metering.data as unknown as {
      shadowedRange?: { start: number; end: number };
      shadowedSeqs?: number[];
    };
    if (data.shadowedRange?.start === startSeq && data.shadowedRange.end === endSeq) continue;
    data.shadowedRange = { start: startSeq, end: endSeq };
    data.shadowedSeqs = events
      .filter(
        (candidate) =>
          candidate.seq >= startSeq &&
          candidate.seq <= endSeq &&
          SURFACE_EVENT_TYPES.has(candidate.type),
      )
      .map((candidate) => candidate.seq);
  }
}

const PTC_EVENT_RENAMES: Record<string, string> = {
  "tool/code-dispatch-start": "tool/ptc-dispatch-start",
  "tool/code-dispatch": "tool/ptc-dispatch",
};

function renamePtcMessageSource(message: unknown): unknown {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  const source = record["source"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) return message;
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord["kind"] !== "plugin" || sourceRecord["plugin"] !== "tools-code-mode") {
    return message;
  }
  return { ...record, source: { ...sourceRecord, plugin: "tools-ptc" } };
}

interface LegacyPtcEvent {
  type: string;
  data: unknown;
  [key: string]: unknown;
}

export function renameLegacyPtcEvents(events: SessionEvent[]): void {
  for (let index = 0; index < events.length; index++) {
    const event = events[index] as unknown as LegacyPtcEvent;
    const renamedType = PTC_EVENT_RENAMES[event.type];
    if (renamedType !== undefined) {
      events[index] = { ...event, type: renamedType } as unknown as SessionEvent;
      continue;
    }
    if (event.type === "agent-preset/selected") {
      const data = event.data as Record<string, unknown>;
      if (data["agentPreset"] === "code") {
        events[index] = {
          ...event,
          data: { ...data, agentPreset: "ptc" },
        } as unknown as SessionEvent;
      }
      continue;
    }
    if (event.type === "user/message") {
      const renamed = renamePtcMessageSource(event.data);
      if (renamed !== event.data) {
        events[index] = { ...event, data: renamed } as unknown as SessionEvent;
      }
      continue;
    }
    if (event.type === "agent/inbox/spliced" || event.type === "session/title-llm-request") {
      const data = event.data as Record<string, unknown>;
      const key = event.type === "agent/inbox/spliced" ? "inserted" : "messages";
      const list = data[key];
      if (!Array.isArray(list)) continue;
      const renamed = list.map(renamePtcMessageSource);
      if (renamed.some((message, position) => message !== list[position])) {
        events[index] = {
          ...event,
          data: { ...data, [key]: renamed },
        } as unknown as SessionEvent;
      }
    }
  }
}

export function repairReadView(events: SessionEvent[]): void {
  repairAssistantSettlement(events);
  repairRequestHeaders(events);
  renameLegacyPtcEvents(events);
  repairSurfaceOps(events);
  syncMeteringRanges(events);
  recomputeReplaceProvenance(events);
  repairOrphanInboxSplices(events);
}

interface InboxSpliceLike {
  target?: unknown;
  start?: unknown;
  removedCount?: unknown;
  inserted?: Array<{ id?: unknown }>;
}

export function orphanInboxSpliceSeqs(events: readonly SessionEvent[]): Set<number> {
  const inbox: Record<string, Array<{ id: string }>> = { "next-turn": [], "next-step": [] };
  const orphan = new Set<number>();
  for (const raw of events) {
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

  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.fType === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }

  const preserved: SessionEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i];
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: unparsable committed event at seq ${rows[i]?.fSequence}`,
        );
      break;
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`,
        );
      break;
    }
    preserved.push(p.event);
  }

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

export function titleOfEventData(data: string): string | undefined {
  try {
    const value = JSON.parse(data) as { data?: { title?: unknown }; title?: unknown };
    const title = value.data?.title ?? value.title;
    return typeof title === "string" ? title : undefined;
  } catch {
    return undefined;
  }
}
