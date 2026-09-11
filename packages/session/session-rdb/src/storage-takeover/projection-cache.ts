/**
 * 投影 checkpoint 服务（`ctx.sessionProjectionCache`）的 rdb 实现：替换上游
 * `@deepseek-ai/dsh-session-projection-cache` 插件，公开面与语义逐一对齐
 * （cachedSnapshot / cachedPredecessorTitle / hydratePrepared / write /
 * coldSnapshot，以及三个强制写点与计数/定时节流），持久层换成 session-rdb
 * 的语义专用表 `t_session_projcache` / `t_session_projcache_row`。
 *
 * 读方法是同步签名（session 列表在请求路径上直接调用），所以服务持有启动时
 * 从表中加载的内存 checkpoint 表；写先落库、后更新内存，保证读到的内存值
 * 磁盘上一定存在。
 */

import { Context, Service } from "@deepseek-ai/cordis";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionSeqCursor,
} from "@deepseek-ai/dsh-session";
import type {
  ProjectionCheckpoint,
  ProjectionSnapshot,
  SessionProjectionMap,
} from "@deepseek-ai/dsh-session-projection";
import type {
  StorageRepository,
  StoredProjcacheEntry,
  CheckpointIdentity,
  ProjectionCheckpointRow,
} from "./types.ts";

/** 服务注册名（与上游插件一致，消费者经 `ctx.get` 解析）。 */
export const SESSION_PROJECTION_CACHE_SERVICE = "sessionProjectionCache";

/** 完整身份：当前世代写入的字段都必需。 */
type CurrentCheckpointIdentity = CheckpointIdentity & {
  formatVersion: number;
  isSeeded: boolean;
  inheritedEventCount: number;
};

/** 缓存写节流参数（上游 Config 的部署值）。 */
export interface ProjectionCacheConfig {
  /** 两次强制点之间，累积多少个已提交事件强制落一次盘。 */
  writeEveryEvents: number;
  /** 脏 checkpoint 在强制点之间允许滞留的最长毫秒数。 */
  writeIntervalMs: number;
}

/** 每会话写回节流簿记（只对 live session）。 */
interface DirtyState {
  pending: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** 只认 title 的前代提示（与上游一致）。 */
const PREDECESSOR_TITLE_KEY = "title" as Extract<keyof SessionProjectionMap, string>;

/** rdb 持久化的投影 checkpoint 服务：同步驱动直读介质，异步驱动用写穿镜像支撑同步签名。 */
export class SessionProjectionCacheRdb extends Service {
  static inject = ["sessionProjections", "sessions"];

  /** 异步驱动（PostgreSQL）的同步读镜像：同步驱动（SQLite）直读介质，这里恒为空。 */
  private readonly records = new Map<SessionId, StoredProjcacheEntry>();
  private readonly dirty = new Map<Session, DirtyState>();
  /** 读路径是否直读介质（`readProjcacheSync` 存在即同步驱动）。 */
  private readonly directReads: boolean;

  /**
   * @param ctx - 插件上下文（须已注入 sessionProjections 与 sessions）。
   * @param config - 写节流参数。
   * @param repository - storages 接管表访问层。
   * @param ready - 介质就绪信号（直读介质前必须等到）。
   */
  constructor(
    ctx: Context,
    private readonly config: ProjectionCacheConfig,
    private readonly repository: StorageRepository,
    private readonly ready: Promise<unknown>,
  ) {
    super(ctx, SESSION_PROJECTION_CACHE_SERVICE);
    this.directReads = repository.readProjcacheSync !== undefined;
  }

  /**
   * Wait for the medium, then install the write path. Only the async driver
   * needs a startup mirror: the sync driver serves every read from the table.
   */
  protected async [Service.init](): Promise<void> {
    await this.ready;
    if (!this.directReads) {
      for (const entry of await this.repository.loadProjcache()) {
        this.records.set(entry.sessionId as SessionId, entry);
      }
    }
    this.installWritePath();
  }

  /** Read one session's stored record: straight from the medium, or from the async mirror. */
  private lookup(id: SessionId): StoredProjcacheEntry | undefined {
    if (this.directReads) return this.repository.readProjcacheSync?.(id);
    return this.records.get(id);
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(
    id: SessionId,
    expected: CurrentCheckpointIdentity,
  ): StoredProjcacheEntry | undefined {
    const record = this.lookup(id);
    if (record === undefined) return undefined;
    return identityMatches(record.identity, expected) ? record : undefined;
  }

  /**
   * The cached projection cut for one stored (cold) or live header.
   * @param meta - authoritative Session header.
   * @param inheritedEventCount - exact inherited cut completing the lifecycle identity.
   * @param keys - optional projection keys required by the caller's audience.
   * @returns the cut (`asOfSeq` = lowest served-row watermark), or `undefined`
   *   when no usable row exists for this lifecycle.
   */
  cachedSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const record = this.recordFor(meta.id, identityOf(meta, inheritedEventCount));
    const snapshot = record === undefined ? undefined : this.viewRecord(record, keys);
    return this.withDirectTitle(meta.id, keys, snapshot);
  }

  /**
   * 标题是会话数据本身（`t_sessions.f_title`，由 rdb 写路径与 rewind 维护）：
   * checkpoint 行里没有 title 时直接取该列，列表消费不依赖缓存行是否存在。
   */
  private withDirectTitle(
    id: SessionId,
    keys: readonly Extract<keyof SessionProjectionMap, string>[] | undefined,
    snapshot: ProjectionSnapshot | undefined,
  ): ProjectionSnapshot | undefined {
    if (keys !== undefined && !(keys as readonly string[]).includes(PREDECESSOR_TITLE_KEY)) {
      return snapshot;
    }
    if (snapshot?.values[PREDECESSOR_TITLE_KEY] !== undefined) return snapshot;
    const direct = this.repository.readSessionTitleSync?.(id);
    if (direct === undefined) return snapshot;
    const values = { ...snapshot?.values, [PREDECESSOR_TITLE_KEY]: direct.title };
    // 水位取最低（under-claim 安全）：已有块的水位与直取行取小。
    const asOfSeq =
      snapshot === undefined ? direct.seq : Math.min(snapshot.asOfSeq as number, direct.seq);
    return { asOfSeq: asOfSeq as SessionSeqCursor, values };
  }

  /**
   * Read only a predecessor checkpoint's title as a zero-I/O listing hint.
   * @param meta - authoritative listed Session header.
   * @param inheritedEventCount - exact inherited cut completing the lifecycle identity.
   * @returns a title-only checkpoint view with `asOfSeq: -1`, or `undefined`
   *   when the record is current, newer, unrelated, missing, or incompatible
   *   with the title unit.
   */
  cachedPredecessorTitle(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
  ): ProjectionSnapshot | undefined {
    const expected = identityOf(meta, inheritedEventCount);
    const record = this.lookup(meta.id);
    if (record === undefined || !predecessorIdentityMatches(record.identity, expected)) {
      return undefined;
    }
    const title = this.viewRecord(record, [PREDECESSOR_TITLE_KEY]);
    return title === undefined ? undefined : { ...title, asOfSeq: -1 };
  }

  /** View selected wire rows and bind them to their lowest served watermark. */
  private viewRecord(
    record: StoredProjcacheEntry,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const values = this.ctx.sessionProjections.viewCheckpoint(
      record.rows as unknown as ProjectionCheckpoint,
      keys,
    );
    const servedKeys = Object.keys(values);
    if (servedKeys.length === 0) return undefined;
    // The block carries ONE cut: the lowest served watermark is the seq every
    // value is at least current as of (under-claiming is safe under
    // higher-seq-wins; over-claiming would let a stale value outrank pushes).
    const firstKey = servedKeys[0] as string;
    let asOfSeq = (record.rows[firstKey] as ProjectionCheckpointRow).seq as SessionSeqCursor;
    for (const key of servedKeys.slice(1)) {
      const row = record.rows[key] as ProjectionCheckpointRow;
      if ((row.seq as number) < (asOfSeq as number)) asOfSeq = row.seq as SessionSeqCursor;
    }
    return { asOfSeq, values };
  }

  /**
   * Hydrate projection cells for an already-prepared Session without another
   * persistence read. The cache seeds matching rows; the supplied exact log
   * advances every unit to the observation cut. No checkpoint is written
   * because the logical observation may contain recovery events not yet durable.
   * @param session - exact unpublished Session retained by persistence.
   * @param events - exact logical event prefix represented by the observation.
   * @returns all projection values at the event cut.
   */
  hydratePrepared(session: Session, events: readonly SessionEvent[]): ProjectionSnapshot {
    const record = this.recordFor(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
    );
    if (record === undefined) {
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0));
    }
    try {
      return this.ctx.sessionProjections.hydrate(
        session,
        record.rows as unknown as ProjectionCheckpoint,
        events,
        SessionLogOffset(0),
      );
    } catch {
      // Cached rows are disposable derived data. Retry from the exact log so a
      // stale schema cannot make a valid Session unreadable.
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0));
    }
  }

  /**
   * Durably checkpoint one live session NOW (all mandatory points call this).
   * NOT fail-soft — callers on the fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability.
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session);
    this.markClean(session);
    // Durability barrier: the checkpoint cut was taken above, so flushing
    // AFTER it guarantees every event inside the cut is durably logged
    // before the cache row lands — a crash can leave the cache behind the
    // log (longer tail replay) but never ahead of it (phantom values folded
    // from events no stored log contains).
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session);
    await this.put(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
      rows as unknown as Record<string, ProjectionCheckpointRow>,
    );
  }

  /**
   * Cold-read one session's projections from its complete log. Each unit is
   * seeded from the identity-checked cached rows and the refreshed checkpoint
   * is written back (fail-soft, fire-and-forget).
   * @param meta - the stored session header (identity witness).
   * @param inheritedEventCount - exact inherited prefix length for projection initialization and identity.
   * @param events - the session's complete log, in seq order.
   * @returns the projection cut at the log end.
   */
  coldSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const identity = identityOf(meta, inheritedEventCount);
    const restored = this.ctx.sessionProjections.restore(
      (this.recordFor(meta.id, identity)?.rows ?? {}) as unknown as ProjectionCheckpoint,
      events,
      SessionLogOffset(0),
      meta,
      inheritedEventCount,
    );
    // Refresh the row so the next cold read seeds from it; fail-soft and
    // fire-and-forget — a failed write-back only costs a longer tail replay.
    void this.put(
      meta.id,
      identity,
      restored.checkpoint as unknown as Record<string, ProjectionCheckpointRow>,
    ).catch((error: unknown) => {
      this.ctx.logger.warn(
        `session projection cache: cold-read write-back for "${meta.id}" failed (cache stays stale): ${String(error)}`,
      );
    });
    return restored.snapshot;
  }

  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on("session/event", (session: Session, event: SessionEvent) => {
      if (event.type === "turn/end") {
        void this.flushSoft(session, "turn/end");
        return;
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined };
      this.dirty.set(session, state);
      state.pending += 1;
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, "count threshold");
        return;
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, "interval");
      }, this.config.writeIntervalMs);
    });

    // Creation is the FIRST mandatory point: a session that never talks (a
    // forked child seeded with its ancestor's title, say) would otherwise
    // get its first row only at detach.
    this.ctx.on("session/created", (session: Session) => {
      void this.flushSoft(session, "create");
    });

    // Detach (the live-to-cold moment): the final mandatory point.
    this.ctx.on("session/disposed", (session: Session) => {
      void this.flushSoft(session, "detach");
      this.markClean(session);
      this.dirty.delete(session);
    });

    this.ctx.effect(
      () => () => {
        for (const state of this.dirty.values()) {
          if (state.timer !== undefined) clearTimeout(state.timer);
        }
        this.dirty.clear();
      },
      "sessionProjectionCacheRdb.timers",
    );
  }

  /** One fail-soft durable checkpoint. */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session);
    } catch (error) {
      this.ctx.logger.warn(
        `session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`,
      );
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session);
    if (state === undefined) return;
    state.pending = 0;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  /** Replace one session's stored record with its log identity and a detached snapshot of `rows`. */
  private async put(
    id: SessionId,
    identity: CheckpointIdentity,
    rows: Record<string, ProjectionCheckpointRow>,
  ): Promise<void> {
    const detached = detachJson(rows);
    // 介质只存行：checkpoint 的 identity 由会话行承载（直读时现取）。
    await this.repository.putProjcache(id, detached);
    // 异步驱动的镜像要 identity 才能做校验，随写入一起带上。
    if (!this.directReads) this.records.set(id, { sessionId: id, identity, rows: detached });
  }
}

/** Detach one checkpoint from live unit state, refusing non-lossless JSON. */
function detachJson(
  rows: Record<string, ProjectionCheckpointRow>,
): Record<string, ProjectionCheckpointRow> {
  let text: string | undefined;
  try {
    text = JSON.stringify(rows);
  } catch (error) {
    throw new TypeError(
      `projection checkpoint is not losslessly JSON-serializable: ${String(error)}`,
      { cause: error },
    );
  }
  if (text === undefined) {
    throw new TypeError("projection checkpoint is not losslessly JSON-serializable");
  }
  return JSON.parse(text) as Record<string, ProjectionCheckpointRow>;
}

/** Project a header onto the identity fields a record is bound to. */
function identityOf(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): CurrentCheckpointIdentity {
  const cut = SessionLogOffset(inheritedEventCount);
  if (!header.isSeeded && cut !== 0) {
    throw new Error("unseeded projection-cache identity inherited event count must be 0");
  }
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    isSeeded: header.isSeeded,
    inheritedEventCount: cut,
  };
}

/**
 * Whether a stored record's bound identity names the caller's lifecycle.
 * An absent format generation cannot prove the fold semantics and never
 * matches. Once the format matches, absent lineage fields (records admitted
 * via compatible versions predate them) read as the unseeded lineage.
 */
function identityMatches(stored: CheckpointIdentity, expected: CurrentCheckpointIdentity): boolean {
  return (
    stored.formatVersion === expected.formatVersion && lifecycleIdentityMatches(stored, expected)
  );
}

/** Match one predecessor cache record to the authoritative listed lifecycle. */
function predecessorIdentityMatches(
  stored: CheckpointIdentity,
  expected: CurrentCheckpointIdentity,
): boolean {
  const predecessor =
    stored.formatVersion === undefined || stored.formatVersion < expected.formatVersion;
  return predecessor && lifecycleIdentityMatches(stored, expected);
}

/** Match the format-independent fields that distinguish one Session lifecycle. */
function lifecycleIdentityMatches(
  stored: CheckpointIdentity,
  expected: CurrentCheckpointIdentity,
): boolean {
  return (
    stored.createdAt === expected.createdAt &&
    stored.cwd === expected.cwd &&
    (stored.isSeeded ?? false) === expected.isSeeded &&
    (stored.inheritedEventCount ?? 0) === expected.inheritedEventCount
  );
}
