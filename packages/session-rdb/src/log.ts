/**
 * 会话 log 的表示转换：把持久化行（`t_sessions` / joined `t_session_events` +
 * `t_events` 行）转换为上游 `SessionHeader` / `SessionEvent`，以及反向的
 * 分类/映射辅助。全部为方言无关的纯函数，无 I/O——测试直接单测（见
 * `tests/rdb.spec.ts`）。
 *
 * 坐标模型（单一稠密坐标 + 读时集中转换）：`t_session_events.f_sequence` 是
 * 稠密持久化 seq（瞬时事件 `assistant/chunk` 与 ignorable 不入库，幸存事件
 * 稠密重编号）；`f_original_seq` 记录上游 seq。写路径零转换（`f_data` 完整
 * 原始 data、`f_surface_op` 原始坐标原样落库）；读取时经 `buildSeqMap`
 * （上游→稠密映射）把 `replace` 范围与 compact 计量事件的 `shadowedRange`
 * 重映射回稠密 seq 空间，`recomputeReplaceProvenance` 对 replace 事件重计算
 * `sourceEventSeqs`（不落库）。`scanRows` 实现崩溃尾部语义（torn tail 切割
 * + 提交区损坏拒绝）。
 *
 * @module @morlay/session-rdb/log
 */

import type { SessionEvent, SessionHeader, SessionId, SurfaceOp } from "@deepseek-ai/dsh-session";
import type { EventRow, SessionRow } from "./backend.ts";

/**
 * Reconstruct the {@link SessionHeader} from a `t_sessions` row.
 * @param row - the `t_sessions` table row.
 * @returns the header, `NULL` columns mapped to omitted optional fields.
 */
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
    ...(row.fSeedLength !== null ? { seedLength: row.fSeedLength } : {}),
    ...(row.fOrigin !== null ? { origin: row.fOrigin as "subagent" } : {}),
    ...(row.fDelegationDepth === null ? {} : { delegationDepth: row.fDelegationDepth }),
  };
}

/**
 * `t_sessions` 的 INSERT 列值：`SessionHeader` 的持久化字段 + 初始 head 游标
 * （空事件 id、seq -1）+ materialization identity（`f_incarnation`）+ revision 0。
 * 方言无关的纯映射——SQLite 与 PostgreSQL 后端的 `upsertSession` 共用，列名
 * 与 `src/entities/sessions.ts` 对齐（改一处即两方言生效）。`f_id` serial 由
 * 数据库生成，不在映射内。
 */
export function sessionInsertRow(
  meta: SessionHeader,
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
  return {
    fSessionId: meta.id,
    fHeadEventId: "",
    fHeadSequence: -1,
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fSeedLength: meta.seedLength ?? null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null,
    fIncarnation: incarnation,
    fRevision: 0,
  };
}

/**
 * `t_sessions` 的 ON CONFLICT 更新列值：只刷新 header 列，保留 head 游标
 * （`f_head_event_id`/`f_head_sequence`）与 materialization identity
 * （`f_incarnation`/`f_revision`）。方言无关，两后端共用（见
 * {@link sessionInsertRow}）。
 */
export function sessionConflictRow(meta: SessionHeader): {
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fSeedLength: number | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;
} {
  return {
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fSeedLength: meta.seedLength ?? null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null,
  };
}

/**
 * Remap a stored {@link SurfaceOp} from upstream seqs to dense persisted seqs.
 * An `append` op carries no seqs; a positional `replace`'s `start`/`end` name
 * surface nodes by UPSTREAM seq and must follow the upstream→persisted map
 * when delta filtering re-numbered the log — otherwise the replacement range
 * is looked up against DENSE seqs and the surface fold rejects the log
 * ("start seq N not found in surface").
 * @param op - the stored surface op (original coordinates).
 * @param remap - upstream→persisted seq mapping.
 * @returns the remapped surface op.
 */
export function remapSurfaceOp(op: SurfaceOp, remap: (seq: number) => number): SurfaceOp {
  if (op === "append") return op;
  return { op: "replace", start: remap(op.start), end: remap(op.end) };
}

/**
 * The compact metering events (`compaction/summary`, `compaction/prune`) carry the
 * token-meter's shadow-price claim in `data.shadowedRange`: the inclusive
 * surface-node seqs of the range the IMMEDIATELY following surface `replace`
 * shadows. The range names surface nodes by UPSTREAM seq, so it must follow
 * the replace's `surfaceOp` through the same upstream→persisted map — the
 * fold compares claim and replacement ranges for exact equality, and an
 * un-remapped claim (upstream) next to a remapped replacement range (dense)
 * makes replay fail loud ("token surface: replace ... has no adjacent shadow
 * price").
 * @param range - the stored shadowed range (upstream seqs).
 * @param remap - upstream→persisted seq mapping.
 * @returns the remapped shadowed range.
 */
export function remapShadowedRange(
  range: { start: number; end: number },
  remap: (seq: number) => number,
): { start: number; end: number } {
  return { start: remap(range.start), end: remap(range.end) };
}

/**
 * Reconstruct a {@link SessionEvent} from a joined row. `f_data` is the
 * complete original data (turn/step included); the bridge row's `f_surface_op`
 * (original coordinates) is remapped to dense seqs through `seqMap`; the
 * compact metering events' `shadowedRange` follows the same map.
 * @param row - the joined `t_session_events` + `t_events` row.
 * @param seqMap - upstream→persisted seq map (per session).
 * @returns the reconstructed event; throws when a JSON column fails to parse
 *   ({@link scanRows} treats that as a hole, not corruption, in the tail).
 */
export function rowToEvent(row: EventRow, seqMap: ReadonlyMap<number, number>): SessionEvent {
  const remap = (seq: number): number => seqMap.get(seq) ?? seq;
  const surfaceOp =
    row.fSurfaceOp !== null
      ? remapSurfaceOp(JSON.parse(row.fSurfaceOp) as SurfaceOp, remap)
      : undefined;
  const data = JSON.parse(row.fData) as SessionEvent["data"];
  // `compaction/summary` / `compaction/prune` are plugin-merged types whose
  // metering data is not part of the core `SessionEventMap`; narrow through a
  // structural view to remap the shadow-price claim's range (see
  // {@link remapShadowedRange}).
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

/**
 * Build the upstream→persisted seq map for one session's persisted events
 * (only meaningful when delta filtering re-numbered the log).
 *
 * A session re-opened by resume (or forked) persists the seed segment and the
 * new segment in ONE log: the seed rows keep the PARENT session's upstream seqs
 * while the resumed rows carry the child session's own upstream seqs, which
 * renumber from the seed boundary and therefore OVERLAP the parent space. The
 * FIRST mapping wins so a seed-segment event's provenance reference resolves to
 * the seed-space row it actually derived from (rows are ordered by persisted
 * seq, so the seed segment always precedes the resumed one); the resumed
 * segment's references are unique within their own space unless they point at a
 * shared value, which only the parent could have produced first.
 * @param rows - one session's seq rows (upstream + persisted), ordered by seq
 *   ascending (only the two seq columns are needed).
 * @returns map from `f_original_seq` to `f_sequence` (first occurrence wins).
 */
export function buildSeqMap(
  rows: readonly Pick<EventRow, "fSequence" | "fOriginalSeq">[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    if (!map.has(row.fOriginalSeq)) map.set(row.fOriginalSeq, row.fSequence);
  }
  return map;
}

/**
 * The event types that produce model-visible surface nodes (mirror of the
 * upstream `SURFACE_EVENT_TYPES`); only these can appear in a replace's
 * shadowed range, so only their seqs may be merged into provenance.
 */
const SURFACE_EVENT_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

/**
 * Recompute `sourceEventSeqs` for every surface `replace` event in a complete
 * dense log. `sourceEventSeqs` is not persisted; the upstream Session seed
 * validation requires a replace's provenance to include every surface node it
 * shadows (`assertProvenance`'s shadowed check). The recomputed set = every
 * SURFACE node seq inside the (dense) replace range — it satisfies the
 * coverage check by construction, references only earlier events (range nodes
 * precede the replace), and is strictly increasing after sort/dedup.
 * @param events - a session's dense event list (contiguous seqs), read in
 *   full; mutated in place.
 */
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

/**
 * Find the preserved prefix of ordered event rows. Fully written rows in an
 * interrupted final turn remain in the prefix. The first unparsable row or seq
 * gap after the last `turn/end` marks a tolerated torn tail; the same hole in
 * the committed region rejects.
 *
 * @param rows - one session's event rows, ordered by persisted seq ascending.
 * @param base - the persisted seq the first row is expected to carry; `0` for
 *   a whole log, the requested `fromSeq` for a suffix read (`loadStoredFrom`).
 * @param seqMap - upstream→persisted seq map forwarded to {@link rowToEvent}.
 * @returns the preserved event prefix, plus `tornFrom` — the persisted seq the
 *   physical delete starts at — when a torn tail exists.
 */
export function scanRows(
  rows: readonly EventRow[],
  base = 0,
  seqMap: ReadonlyMap<number, number> = new Map(),
): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1: parse each row's data; a row whose data is not valid JSON is a hole.
  // (The seq/type COLUMNS are always present even when `data` is corrupt.)
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

  // The last index that is a valid `turn/end` — holes through a closed turn
  // are always committed corruption.
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.fType === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }

  // Preserve the contiguous prefix, including a complete interrupted turn;
  // holes through the last committed boundary throw, while later holes stop.
  const preserved: SessionEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i];
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: unparsable committed event at seq ${rows[i]?.fSequence}`,
        );
      break; // torn tail fragment after the last turn/end — stop, tolerate
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`,
        );
      break; // gap after the last turn/end — torn tail, stop
    }
    preserved.push(p.event);
  }

  // Any rows past the preserved prefix are a never-committed torn tail; their
  // first seq is the deletion point for load's physical repair.
  return preserved.length < rows.length
    ? { preserved, tornFrom: base + preserved.length }
    : { preserved };
}
