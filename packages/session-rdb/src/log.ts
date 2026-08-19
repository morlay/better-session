/**
 * 会话 log 的表示转换：把持久化行（`t_sessions` / joined `t_session_events` +
 * `t_events` 行）转换为上游 `SessionHeader` / `SessionEvent`，以及反向的
 * 分类/映射辅助。全部为方言无关的纯函数，无 I/O——测试直接单测（见
 * `tests/rdb.spec.ts`）。
 *
 * delta 过滤（`assistant/chunk` 不落库）后，持久化 seq 是稠密重编号的；
 * `buildSeqMap` 提供 上游 seq → 持久化 seq 的映射，`rowToEvent` /
 * `remapSurfaceOp` / `remapShadowedRange` 经它把 `sourceEventSeqs`、
 * `replace` 范围与 compact 计量事件的 `shadowedRange` 重映射回稠密
 * seq 空间。`scanRows` 实现崩溃尾部语义（torn tail 切割 + 提交区损坏拒绝）。
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
 * Remap a stored {@link SurfaceOp} from upstream seqs to persisted seqs. An
 * `append` op carries no seqs; a positional `replace`'s `start`/`end` name
 * surface nodes by UPSTREAM seq and must follow {@link SessionEvent.sourceEventSeqs}
 * through the same upstream→persisted map when delta filtering re-numbered the
 * log — otherwise the replacement range is looked up against DENSE seqs and the
 * surface fold rejects the log ("start seq N not found in surface").
 * @param op - the stored surface op.
 * @param remap - upstream→persisted seq mapping (identity when absent).
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
 * @param remap - upstream→persisted seq mapping (identity when absent).
 * @returns the remapped shadowed range.
 */
export function remapShadowedRange(
  range: { start: number; end: number },
  remap: (seq: number) => number,
): { start: number; end: number } {
  return { start: remap(range.start), end: remap(range.end) };
}

/**
 * Reconstruct a {@link SessionEvent} from a joined row. The emitted event
 * carries the DENSE persisted seq (`row.fSequence`); `sourceEventSeqs` entries,
 * a positional `replace` {@link SurfaceOp}'s range, and the compact metering
 * events' `shadowedRange` are resolved onto persisted seqs through `seqMap`
 * when the log was delta-filtered.
 *
 * Coordinate resolution is "the stored f_sequence wins, when it is a valid
 * earlier reference": after resume the upstream live log IS the dense log,
 * so events written since (checkpoint replaces, provenance) cite DENSE seqs.
 * A cited seq that exists in the dense space, precedes this event, and is
 * either a SURFACE node or has no upstream counterpart is kept as-is. A seq
 * outside the dense space (or a dense seq that is a non-surface event with an
 * upstream counterpart — an upstream-cited seq that happens to collide with a
 * later dense seq) is treated as an UPSTREAM reference and remapped through
 * the upstream→persisted map, again only when the result precedes this event.
 * Anything else is unresolvable and dropped (never kept verbatim — after
 * rewind re-uses the upstream space, keeping an upstream value would mix
 * coordinates and fail the Session seed validation).
 * @param row - the joined `t_session_events` + `t_events` row.
 * @param seqMap - upstream→persisted seq map (optional).
 * @param denseTypeMap - every persisted f_sequence → event type for the
 *   session (optional; always passed together with `seqMap`).
 * @returns the reconstructed event; throws when a JSON column fails to parse
 *   ({@link scanRows} treats that as a hole, not corruption, in the tail).
 */
export function rowToEvent(
  row: EventRow,
  seqMap?: ReadonlyMap<number, number>,
  denseTypeMap?: ReadonlyMap<number, string>,
): SessionEvent {
  // Surface-metadata fields are conditional on the event type in the type
  // system; spread them so each variant gets only the fields it declares.
  // `sourceEventSeqs` must never mix coordinates: an unresolvable reference is
  // dropped, and the survivors are sorted/de-duplicated — see
  // {@link remapProvenance}. A fully pruned list is omitted entirely (the
  // event carries no provenance), matching the write path's null storage.
  const remap = (seq: number): number =>
    resolveProvenanceSeq(seq, row.fSequence, seqMap, denseTypeMap) ?? seq;
  const strictRemap = (seq: number): number | undefined =>
    resolveProvenanceSeq(seq, row.fSequence, seqMap, denseTypeMap);
  const surfaceFields = {
    ...(row.fSourceEventSeqs !== null
      ? (() => {
          const refs = remapProvenance(JSON.parse(row.fSourceEventSeqs) as number[], strictRemap);
          return refs.length > 0 ? { sourceEventSeqs: refs } : {};
        })()
      : {}),
    ...(row.fSurfaceOp !== null
      ? {
          surfaceOp: remapSurfaceOp(JSON.parse(row.fSurfaceOp) as SurfaceOp, remap),
        }
      : {}),
  };
  const data = JSON.parse(row.fData) as SessionEvent["data"];
  // `compaction/summary` / `compaction/prune` are plugin-merged types whose
  // metering data is not part of the core `SessionEventMap`; narrow through a
  // structural view to remap the shadow-price claim's range (see
  // {@link remapShadowedRange}).
  if (row.fKind === "compaction/summary" || row.fKind === "compaction/prune") {
    const metering = data as unknown as { shadowedRange?: { start: number; end: number } };
    if (metering.shadowedRange !== undefined) {
      metering.shadowedRange = remapShadowedRange(metering.shadowedRange, remap);
    }
  }
  return {
    type: row.fKind as SessionEvent["type"],
    seq: row.fSequence,
    time: row.fCreatedAt,
    data,
    ...surfaceFields,
  } as SessionEvent;
}

/**
 * Resolve one cited seq onto the DENSE persisted seq space.
 *
 * "The stored f_sequence wins, when it is a valid earlier reference": after
 * resume the upstream live log IS the dense log, so events written since
 * (checkpoint replaces, provenance) cite DENSE seqs. A cited seq that exists
 * in the dense space, precedes `eventSeq`, and is either a SURFACE node or has
 * no upstream counterpart is kept as-is. A seq outside the dense space (or a
 * dense seq that is a non-surface event with an upstream counterpart — an
 * upstream-cited seq that happens to collide with a later dense seq) is
 * treated as an UPSTREAM reference and remapped through the upstream→persisted
 * map, again only when the result precedes `eventSeq`. Anything else is
 * unresolvable (`undefined`): provenance entries are dropped rather than kept
 * verbatim, because after rewind re-uses the upstream space an upstream value
 * would mix coordinates and fail the Session seed validation.
 * @param seq - the cited seq (upstream or dense).
 * @param eventSeq - the citing event's dense seq.
 * @param seqMap - upstream→persisted seq map (optional).
 * @param denseTypeMap - every persisted f_sequence → event type (optional;
 *   always passed together with `seqMap`).
 * @returns the dense seq to cite, or undefined when unresolvable.
 */
export function resolveProvenanceSeq(
  seq: number,
  eventSeq: number,
  seqMap?: ReadonlyMap<number, number>,
  denseTypeMap?: ReadonlyMap<number, string>,
): number | undefined {
  if (seqMap === undefined && denseTypeMap === undefined) return seq;
  const kind = denseTypeMap?.get(seq);
  if (
    kind !== undefined &&
    seq < eventSeq &&
    (SURFACE_EVENT_TYPES.has(kind) || !seqMap?.has(seq))
  ) {
    return seq;
  }
  const dense = seqMap?.get(seq);
  if (dense !== undefined && dense < eventSeq) return dense;
  return undefined;
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
 * Normalize a stored provenance list into the persisted seq space.
 *
 * `sourceEventSeqs` references events by UPSTREAM seq; on read each entry is
 * remapped to the DENSE persisted seq through the upstream→persisted map. An
 * entry whose event never got a persisted row (a dropped delta) or no longer
 * has one cannot be remapped. Keeping such an entry verbatim would mix
 * upstream and dense coordinates in one list — after rewind re-uses the
 * upstream seq space, a stale reference can even collide with a live dense
 * seq — which the upstream Session seed validation rejects (duplicates /
 * non-monotonic / "must reference earlier events"). Unmappable entries are
 * dropped. Because the upstream space is reused, the remapped entries can
 * also arrive out of order or duplicated; the result is sorted and
 * de-duplicated so it is strictly increasing, as the upstream provenance
 * contract requires. The output's SET (the only thing surface-replace
 * shadowing checks) is unchanged by normalization.
 * @param refs - the event's `sourceEventSeqs` (upstream seqs).
 * @param remap - upstream→persisted seq mapping; undefined for an entry
 *   whose event has no persisted row.
 * @returns the normalized, strictly increasing persisted seqs (possibly empty).
 */
export function remapProvenance(
  refs: readonly number[],
  remap: (seq: number) => number | undefined,
): number[] {
  const mapped: number[] = [];
  for (const ref of refs) {
    const dense = remap(ref);
    if (dense !== undefined) mapped.push(dense);
  }
  mapped.sort((a, b) => a - b);
  const result: number[] = [];
  for (const seq of mapped) {
    if (result.length === 0 || result[result.length - 1] !== seq) result.push(seq);
  }
  return result;
}

/**
 * The event types that produce model-visible surface nodes (mirror of the
 * upstream `SURFACE_EVENT_TYPES`); only these can appear in a replace's
 * shadowed range, so only their seqs may be merged into provenance.
 */
const SURFACE_EVENT_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

/**
 * Make a surface `replace` event's provenance cover its replacement range.
 *
 * The upstream Session seed validation requires a replace's `sourceEventSeqs`
 * to include every surface node it shadows (`assertProvenance`'s shadowed
 * check). Rewind re-uses the upstream seq space: a replace that survives a
 * truncation (e.g. a checkpoint `user/message` before the new boundary) has
 * its range remapped onto DENSE seqs, while its provenance references were
 * written in upstream seqs — references to rows rewind deleted are dropped on
 * read, so the surviving provenance no longer covers the range's dense nodes.
 * Merging every persisted SURFACE node seq inside the (dense) range into the
 * provenance makes the log loadable again; extra references are legal
 * provenance and never affect the fold (the fold consumes only the surfaceOp
 * range). Only events the map could resolve exist in the dense range, so the
 * merged list is strictly increasing after sort/dedup.
 * @param events - a session's dense event list (contiguous seqs), read in
 *   full; mutated in place.
 */
export function normalizeSurfaceReplaceProvenance(events: SessionEvent[]): void {
  for (const event of events) {
    const raw = event as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: number[] };
    const op = raw.surfaceOp;
    if (typeof op !== "object" || op === null || (op as { op?: string }).op !== "replace") {
      continue;
    }
    const { start, end } = op as { start: number; end: number };
    const refs = new Set(raw.sourceEventSeqs ?? []);
    for (const candidate of events) {
      if (candidate.seq >= start && candidate.seq <= end && SURFACE_EVENT_TYPES.has(candidate.type)) {
        refs.add(candidate.seq);
      }
    }
    raw.sourceEventSeqs = [...refs].sort((a, b) => a - b);
  }
}

/**
 * Prune `sourceEventSeqs` references that cannot be remapped on read.
 *
 * `sourceEventSeqs` references events by UPSTREAM seq; on read the references
 * are remapped to the DENSE persisted seq through {@link buildSeqMap}. A
 * reference whose event never got a persisted row (a dropped delta, or a seq
 * that never existed) has no map entry and would replay as a `source >=
 * current seq` provenance violation, so the write path prunes it. A fully
 * pruned list is stored as null (no provenance) by the serializer.
 *
 * The `keep` predicate is the CALLER's view of resolvability: the write path
 * knows which upstream seqs THIS INSTANCE dropped (`WriteGuard.pruneRefs` —
 * per-instance knowledge, which must not prune references to rows another
 * instance persisted, e.g. a resume seed segment), while the one-shot repair
 * script knows which upstream seqs exist on DISK (full-database view). The
 * filter itself is shared so the rule lives in one place.
 * @param refs - the event's `sourceEventSeqs` (upstream seqs).
 * @param keep - true for a seq whose referenced event is resolvable.
 * @returns the pruned list.
 */
export function pruneSourceEventSeqs(
  refs: readonly number[],
  keep: (seq: number) => boolean,
): number[] {
  return refs.filter(keep);
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
 * @param denseTypeMap - every persisted f_sequence → type, forwarded to
 *   {@link rowToEvent} (kept together with `seqMap`).
 * @returns the preserved event prefix, plus `tornFrom` — the persisted seq the
 *   physical delete starts at — when a torn tail exists.
 */
export function scanRows(
  rows: readonly EventRow[],
  base = 0,
  seqMap?: ReadonlyMap<number, number>,
  denseTypeMap?: ReadonlyMap<number, string>,
): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1: parse each row's data; a row whose data is not valid JSON is a hole.
  // (The seq/type COLUMNS are always present even when `data` is corrupt.)
  interface Parsed {
    ok: boolean;
    event?: SessionEvent;
  }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row, seqMap, denseTypeMap) };
    } catch {
      return { ok: false };
    }
  });

  // The last index that is a valid `turn/end` — holes through a closed turn
  // are always committed corruption.
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.fKind === "turn/end") {
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
