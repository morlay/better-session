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

export const SESSION_PROJECTION_CACHE_SERVICE = "sessionProjectionCache";

type CurrentCheckpointIdentity = CheckpointIdentity & {
  formatVersion: number;
  isSeeded: boolean;
  inheritedEventCount: number;
};

export interface ProjectionCacheConfig {
  writeEveryEvents: number;

  writeIntervalMs: number;
}

export interface SessionProjectionCacheRdbOptions extends ProjectionCacheConfig {
  repository: StorageRepository;
  ready: Promise<unknown>;
}

interface DirtyState {
  pending: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const PREDECESSOR_TITLE_KEY = "title" as Extract<keyof SessionProjectionMap, string>;

export class SessionProjectionCacheRdb extends Service {
  static inject = ["sessionProjections", "sessions"];

  private readonly records = new Map<SessionId, StoredProjcacheEntry>();
  private readonly dirty = new Map<Session, DirtyState>();

  private readonly directReads: boolean;
  private readonly config: ProjectionCacheConfig;
  private readonly repository: StorageRepository;
  private readonly ready: Promise<unknown>;

  constructor(ctx: Context, options: SessionProjectionCacheRdbOptions) {
    super(ctx, SESSION_PROJECTION_CACHE_SERVICE);
    this.config = options;
    this.repository = options.repository;
    this.ready = options.ready;
    this.directReads = options.repository.readProjcacheDirect !== undefined;
  }

  protected async [Service.init](): Promise<void> {
    this.installWritePath();
    await this.ready;

    const pruned = await this.repository.pruneStaleProjcache();
    if (pruned > 0) {
      this.ctx.logger.info(
        `session projection cache: pruned stale snapshot(s) for ${String(pruned)} session(s)`,
      );
    }
    if (!this.directReads) {
      for (const entry of await this.repository.loadProjcache()) {
        this.records.set(entry.sessionId as SessionId, entry);
      }
    }
  }

  private lookup(id: SessionId): StoredProjcacheEntry | undefined {
    if (this.directReads) return this.repository.readProjcacheDirect?.(id);
    return this.records.get(id);
  }

  private recordFor(
    id: SessionId,
    expected: CurrentCheckpointIdentity,
  ): StoredProjcacheEntry | undefined {
    const record = this.lookup(id);
    if (record === undefined) return undefined;
    return identityMatches(record.identity, expected) ? record : undefined;
  }

  cachedSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const record = this.recordFor(meta.id, identityOf(meta, inheritedEventCount));
    const snapshot = record === undefined ? undefined : this.viewRecord(record, keys);
    return this.withDirectTitle(meta.id, keys, snapshot);
  }

  private withDirectTitle(
    id: SessionId,
    keys: readonly Extract<keyof SessionProjectionMap, string>[] | undefined,
    snapshot: ProjectionSnapshot | undefined,
  ): ProjectionSnapshot | undefined {
    if (keys !== undefined && !(keys as readonly string[]).includes(PREDECESSOR_TITLE_KEY)) {
      return snapshot;
    }
    if (snapshot?.values[PREDECESSOR_TITLE_KEY] !== undefined) return snapshot;
    const direct = this.repository.readSessionTitleDirect?.(id);
    if (direct === undefined) return snapshot;
    const values = { ...snapshot?.values, [PREDECESSOR_TITLE_KEY]: direct.title };

    const asOfSeq =
      snapshot === undefined ? direct.seq : Math.min(snapshot.asOfSeq as number, direct.seq);
    return { asOfSeq: asOfSeq as SessionSeqCursor, values };
  }

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

    const firstKey = servedKeys[0] as string;
    let asOfSeq = (record.rows[firstKey] as ProjectionCheckpointRow).seq as SessionSeqCursor;
    for (const key of servedKeys.slice(1)) {
      const row = record.rows[key] as ProjectionCheckpointRow;
      if ((row.seq as number) < (asOfSeq as number)) asOfSeq = row.seq as SessionSeqCursor;
    }
    return { asOfSeq, values };
  }

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
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0));
    }
  }

  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session);
    this.markClean(session);

    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session);
    await this.put(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
      rows as unknown as Record<string, ProjectionCheckpointRow>,
    );
  }

  // rewind 后 head 回退：把水位超出新 head 的投影单元丢弃，保留仍在截断前缀内的行。
  // 这是零 I/O 读的更新（不 fold 日志）：下次零 I/O 读拿到的是截断后的水位，而不是旧值。
  async truncateTo(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    headSeq: number,
  ): Promise<void> {
    const identity = identityOf(meta, inheritedEventCount);
    const record = this.recordFor(meta.id, identity);
    if (record === undefined) return;
    const rows = Object.fromEntries(
      Object.entries(record.rows).filter(
        ([, row]) => ((row as ProjectionCheckpointRow).seq as number) <= headSeq,
      ),
    );
    await this.put(meta.id, identity, rows as unknown as Record<string, ProjectionCheckpointRow>);
  }

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

  private installWritePath(): void {
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

    this.ctx.on("session/created", (session: Session) => {
      void this.flushSoft(session, "create");
    });

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

  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session);
    } catch (error) {
      this.ctx.logger.warn(
        `session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`,
      );
    }
  }

  private markClean(session: Session): void {
    const state = this.dirty.get(session);
    if (state === undefined) return;
    state.pending = 0;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  private async put(
    id: SessionId,
    identity: CheckpointIdentity,
    rows: Record<string, ProjectionCheckpointRow>,
  ): Promise<void> {
    const detached = detachJson(rows);

    await this.repository.putProjcache(id, detached);

    if (!this.directReads) this.records.set(id, { sessionId: id, identity, rows: detached });
  }
}

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

function identityMatches(stored: CheckpointIdentity, expected: CurrentCheckpointIdentity): boolean {
  return (
    stored.formatVersion === expected.formatVersion && lifecycleIdentityMatches(stored, expected)
  );
}

function predecessorIdentityMatches(
  stored: CheckpointIdentity,
  expected: CurrentCheckpointIdentity,
): boolean {
  const predecessor =
    stored.formatVersion === undefined || stored.formatVersion < expected.formatVersion;
  return predecessor && lifecycleIdentityMatches(stored, expected);
}

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
