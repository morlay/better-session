import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader, SessionId, SurfaceOp } from "@deepseek-ai/dsh-session";
import type { SessionFormatEvent, SessionFormatHeader } from "@deepseek-ai/dsh-session-format";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import type { EventRow, SessionRow } from "./backend.ts";

/**
 * 把桥接行列里的 replace surfaceOp 归一到当前字段名。
 *
 * v2 时代落库的 JSON 用 `start`/`end`，当前格式用 `startSeq`/`endSeq`；
 * 混合世代回退路径直接采用存储行，必须在此归一，否则上游 v3 surface 校验
 * 以「invalid replace surfaceOp」拒绝整个会话。非 replace 形状原样返回，
 * 由读取视图修复决定降级。
 */
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

const SURFACE_EVENT_TYPES = new Set([
  "system/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

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
    // 旧写入器重编号事件后，存储的 range 端点可能落在旧坐标空间：end 不在
    // 当前 surface 中，但紧邻 metering 事件的 shadowedSeqs 仍给出被遮蔽
    // 节点数量。按数量从 start 起夹取到当前 surface 的同长区间，保住压缩
    // 语义（否则只能降级 append，被压缩历史全部回到派生历史）。
    let clamped: number | undefined;
    if (shapeOk && startIdx !== -1 && endIdx === -1) {
      clamped = clampReplaceEnd(events, index, nodes, startIdx);
      if (clamped !== undefined) endIdx = nodes.indexOf(clamped);
    }
    const rangeOk = shapeOk && startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx;
    // assistant/message 的来源内嵌在 stream，上游禁止其携带 sourceEventSeqs，
    // replace 的 provenance 因此永远无法满足 fold 校验——降级 append 是唯一
    // 可加载形态。
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

/**
 * 夹取一个 end 落在旧坐标空间的 replace 的结尾。
 *
 * 仅当 replace 紧邻一个 metering 事件且其 `shadowedSeqs` 是权威数量时成立；
 * 夹取点是从 `start` 起的第 `shadowedSeqs.length` 个当前 surface 节点（不足
 * 则取当前 surface 末尾）。无法夹取（start 也不在当前 surface）时返回
 * `undefined`，由调用方降级为 append。
 */
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

/**
 * 读取时补全 assistant 结算字段：旧写入器不落库 `stream`（v2 才把流式记录
 * 嵌入消息），读回时缺失即补空数组——上游 seed 校验要求 turn/step/stream
 * 三者齐备，缺失会让整个会话加载失败。
 */
export function repairAssistantSettlement(events: SessionEvent[]): void {
  for (const event of events) {
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    const data = event.data as unknown as Record<string, unknown>;
    if (!Array.isArray(data["stream"])) data["stream"] = [];
  }
}

/**
 * 读取时把旧格式 `request/header` 归一为当前格式：v3 起 system prompt 由
 * surface 上的 `system/message` 承载，header 必须省略 `system`，空 `tools` /
 * `adapterDefaults` 也必须省略（上游 v3 事件校验 fail loud）。混合世代回退
 * 视图直接采用存储行，不归一会让整个会话加载失败。system prompt 因此不再
 * 进入模型请求；会话下次运行由 v3 的 system/message 机制重建。
 */
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

/**
 * 把紧邻 replace 的 metering 事件的 `shadowedRange` / `shadowedSeqs` 对齐到
 * replace 最终的稠密 range。
 *
 * 旧写入器重编号事件后，metering 与 replace 一起落在旧坐标空间：二者数值
 * 相等但与当前 surface 无关。夹取（或 range 本身已落在稠密空间而 metering
 * 仍是旧值）后二者不再相等，而上游 token-meter 契约要求紧邻的 metering
 * range 与 replace range 完全一致（否则报 no adjacent shadow price）。range
 * 已一致时不改写——当前写入器保证一致，shadowedSeqs 的额外并发节点因此
 * 原样保留。
 */
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

/** 把消息的 `tools-code-mode` 插件来源改写为 `tools-ptc`（非该来源原样返回）。 */
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

/** 宽类型事件视图：PTC 词汇归一涉及本包 SessionEventMap 之外的插件类型。 */
interface LegacyPtcEvent {
  type: string;
  data: unknown;
  [key: string]: unknown;
}

/**
 * 读取时把 v2 时代的 PTC 词汇归一为当前词汇。
 *
 * 上游 v2→v3 迁移把 `tool/code-dispatch(-start)` 改名为
 * `tool/ptc-dispatch(-start)`、把 `tools-code-mode` 插件来源改名为 `tools-ptc`、
 * 把 agent preset 值 `code` 改名为 `ptc`。混合世代回退视图直接采用存储行，
 * 不重命名会被上游 v3 校验以「unknown event type」拒绝整个会话。词汇改写
 * 与上游迁移链的 renamePtcEvent 对齐。
 */
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

/**
 * 读取视图修复总入口：形状补全（结算字段 / request header）→ PTC 词汇归一
 * → surface 语义修复 → metering 对齐 → provenance 重算 → 孤儿 inbox splice
 * 改写。全部只作用于内存视图，不落库。
 */
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

/**
 * 事件行 JSON → `session/title` 的标题文本。存储层写路径保证 `f_data` 是完整
 * 事件 JSON；形状不符（或损坏）按「无标题」处理——标题是派生显示数据。
 * @param data - `t_events.f_data` 原文。
 * @returns 标题文本，或 `undefined`。
 */
export function titleOfEventData(data: string): string | undefined {
  try {
    // 当前世代：`{...envelope, data:{title}}`；旧世代（v0-v2）的 f_data 直接
    // 平铺事件 data，title 在顶层。两者都读，避免 legacy 会话的标题被清空。
    const value = JSON.parse(data) as { data?: { title?: unknown }; title?: unknown };
    const title = value.data?.title ?? value.title;
    return typeof title === "string" ? title : undefined;
  } catch {
    // 写路径已保证 JSON；此处只可能是损坏数据，读作无标题。
    return undefined;
  }
}
