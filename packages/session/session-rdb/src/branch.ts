import {
  SESSION_FORMAT_VERSION,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import {
  SessionBranch,
  SessionBranchError,
  balanceRewindPrefix,
  buildTimeline,
  rewindKeepLength,
  type BranchAnchorMode,
  type BranchBoundary,
  type ForkFromOptions,
  type SessionBranchProvider,
} from "@morlay/session-branch";
import { randomUUID } from "node:crypto";
import type { Backend } from "./backend.ts";
import type { SessionPersistenceRdb } from "./index.ts";
import { isLegacyVersion } from "./legacy.ts";
import { rowToMeta } from "./log.ts";

function assertRewindBoundary(
  id: SessionId,
  toBoundary: number,
  boundaryType: string | undefined,
  head: number,
): void {
  if (toBoundary === -1) return;
  if (toBoundary > head) {
    throw new SessionBranchError(
      `rewind boundary ${toBoundary} is beyond the stored head ${head}`,
      "INVALID_BOUNDARY",
    );
  }
  if (boundaryType === undefined) {
    throw new SessionBranchError(
      `rewind boundary ${toBoundary} does not exist in session "${id}"`,
      "INVALID_BOUNDARY",
    );
  }
  if (boundaryType !== "turn/end" && boundaryType !== "user/message") {
    throw new SessionBranchError(
      `rewind boundary ${toBoundary} is not a turn/end or user/message (${boundaryType})`,
      "INVALID_BOUNDARY",
    );
  }
}

export function locateTurnEnd(
  events: readonly SessionEvent[],
  atSeq?: number,
  mode: BranchAnchorMode = "after",
): number {
  const ends = events.filter((event) => event.type === "turn/end").map((event) => event.seq);
  if (atSeq === undefined) {
    const last = ends.at(-1);
    if (last === undefined) throw new SessionBranchError("session has no closed turn", "OPEN_TURN");
    return last;
  }
  if (mode === "before") {
    let boundary = -1;
    for (const seq of ends) {
      if (seq < atSeq) boundary = seq;
      else break;
    }
    return boundary;
  }
  const firstAfter = ends.find((seq) => seq >= atSeq);
  if (firstAfter !== undefined) return firstAfter;

  const lastStart = [...events].reverse().find((event) => event.type === "turn/start");
  if (lastStart !== undefined && lastStart.seq <= atSeq) {
    throw new SessionBranchError(`anchor ${atSeq} lies inside an open turn`, "OPEN_TURN");
  }
  const last = ends.at(-1);
  if (last === undefined) throw new SessionBranchError("session has no closed turn", "OPEN_TURN");
  return last;
}

function renumber(events: readonly SessionEvent[], offset: number): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: offset + index }) as SessionEvent);
}

function mintSessionId(): SessionId {
  return `session-${randomUUID()}` as SessionId;
}

export interface LiveSessionHooks {
  getSession(id: SessionId): Session | undefined;

  getAgent(id: SessionId): LiveAgentLike | undefined;

  flush(session: Session): Promise<boolean>;

  warn?(message: string): void;

  resetProjections?(session: Session): void;

  resetTokenMeter?(session: Session): void;

  refreshProjectionCache?(session: ProjectionCacheSession): Promise<void>;
}

export interface ProjectionCacheSession {
  readonly id: SessionId;
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;

  // 没有 live 会话时（cold rewind）缓存按这个新水位截断，不 fold 日志
  readonly headSeq?: number;
  snapshotEvents(): readonly SessionEvent[];
}

interface ProjectionRegistryLike {
  registrations?: Map<string, { cells: WeakMap<object, unknown> }>;
}

interface TokenMeterLike {
  states?: WeakMap<object, unknown>;
}

export interface LiveAgentLike {
  session: Session;

  requestHeaderLogged?: boolean;

  inbox?: { clear(): void };
}

interface SurfaceManagerLike {
  _state: {
    nodes: number[];
    replaceGeneration: number;
    contentGeneration: number;
    projectedMessages: Map<unknown, unknown>;
  };
  _lastProcessedSeq: number;
  _pendingPlan?: unknown;
  baseSeq: number;
}

function resetSurfaceManager(surfaceManager: SurfaceManagerLike): void {
  const state = surfaceManager._state;
  state.nodes = [];
  state.replaceGeneration = 0;
  state.contentGeneration = 0;
  state.projectedMessages = new Map();
  surfaceManager._lastProcessedSeq = surfaceManager.baseSeq - 1;
  surfaceManager._pendingPlan = undefined;
}

export function truncateLiveSession(session: Session, newLength: number): void {
  const s = session as unknown as {
    log: SessionEvent[];
    eventsSnapshot?: unknown;
    headerFold?: unknown;
    headerFoldSeq: number;
    contextFold?: unknown;
    contextFoldSeq: number;
    derived: unknown[];
    derivedNodes: number;
    derivedGeneration: number;
    surfaceManager: SurfaceManagerLike;
  };
  s.log.length = newLength;
  s.eventsSnapshot = undefined;
  s.headerFold = undefined;
  s.headerFoldSeq = 0;
  s.contextFold = undefined;
  s.contextFoldSeq = 0;
  s.derived = [];
  s.derivedNodes = 0;
  s.derivedGeneration = 0;
  resetSurfaceManager(s.surfaceManager);
}

export function replaceLiveSessionLog(session: Session, events: readonly SessionEvent[]): void {
  const s = session as unknown as {
    log: SessionEvent[];
    eventsSnapshot?: unknown;
    headerFold?: unknown;
    headerFoldSeq: number;
    contextFold?: unknown;
    contextFoldSeq: number;
    derived: unknown[];
    derivedNodes: number;
    derivedGeneration: number;
    surfaceManager: SurfaceManagerLike;
  };
  s.log.length = 0;
  s.log.push(...events);
  s.eventsSnapshot = undefined;
  s.headerFold = undefined;
  s.headerFoldSeq = 0;
  s.contextFold = undefined;
  s.contextFoldSeq = 0;
  s.derived = [];
  s.derivedNodes = 0;
  s.derivedGeneration = 0;
  resetSurfaceManager(s.surfaceManager);
}

export class SessionBranchRdbProvider implements SessionBranchProvider {
  readonly name = "session-rdb";

  constructor(
    private readonly persistence: SessionPersistenceRdb,

    private readonly live: LiveSessionHooks = {
      getSession: () => undefined,
      getAgent: () => undefined,
      flush: async () => true,
    },
  ) {}

  async readBranchPrefix(
    id: SessionId,
    atSeq?: number,
    mode: BranchAnchorMode = "after",
    signal?: AbortSignal,
  ): Promise<BranchBoundary> {
    const { events } = await this.readRawEvents(id, signal);
    const boundary = locateTurnEnd(events, atSeq, mode);
    return { seq: boundary, events: events.slice(0, boundary + 1) };
  }

  async readRawEvents(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
    const stored = await this.persistence.readLog(id, {}, signal);
    if (stored === undefined)
      throw new SessionBranchError(`session "${id}" not found`, "SESSION_NOT_FOUND");
    return { meta: stored.meta, events: stored.events };
  }

  async forkFrom(
    sourceId: SessionId,
    options: ForkFromOptions = {},
    signal?: AbortSignal,
  ): Promise<SessionId> {
    signal?.throwIfAborted();
    const { atSeq, anchorMode = "after", seedSuffix = [], childSessionId, meta = {} } = options;
    const source = await this.persistence.readLog(sourceId, {}, signal);
    if (source === undefined)
      throw new SessionBranchError(`session "${sourceId}" not found`, "SESSION_NOT_FOUND");
    const boundary = locateTurnEnd(source.events, atSeq, anchorMode);
    const prefix = balanceRewindPrefix(source.events.slice(0, boundary + 1));
    if (prefix.length <= boundary) {
      this.live.warn?.(
        `session-rdb: fork "${sourceId}" dropped ${boundary + 1 - prefix.length} trailing event(s) from seq ${prefix.length} to keep the seed's step pairs balanced`,
      );
    }
    const childId = childSessionId ?? mintSessionId();
    const childMeta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt: meta.createdAt ?? Date.now(),
      ...(meta.cwd !== undefined
        ? { cwd: meta.cwd }
        : source.meta.cwd !== undefined
          ? { cwd: source.meta.cwd }
          : {}),
      parentSession: sourceId,
      isSeeded: true,
      ...(meta.agentPreset !== undefined
        ? { agentPreset: meta.agentPreset }
        : source.meta.agentPreset !== undefined
          ? { agentPreset: source.meta.agentPreset }
          : {}),
      ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
      ...(meta.delegationDepth !== undefined ? { delegationDepth: meta.delegationDepth } : {}),
    };
    const seed = [...renumber(prefix, 0), ...renumber(seedSuffix, prefix.length)];

    const internals = this.persistence.internals();
    const sourceRows = await internals.backend.getEventRows(sourceId);
    const sourceEventIds = new Map(sourceRows.map((row) => [row.fSequence, row.fEventId]));
    const reuse = new Map<number, string>();
    for (const event of prefix) {
      const eventId = sourceEventIds.get(event.seq);
      if (eventId !== undefined) reuse.set(event.seq, eventId);
    }
    internals.registerReuseEventIds(childId, reuse);
    const handle = await this.persistence.create(childMeta, {
      inheritedEventCount: SessionLogOffset(prefix.length),
    });
    try {
      if (seed.length > 0) await handle.append(seed);
    } finally {
      await handle.close();
    }
    return childId;
  }

  async rewind(
    id: SessionId,
    toBoundary: number,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(toBoundary) || toBoundary < -1) {
      throw new SessionBranchError(
        `rewind boundary must be a non-negative safe integer, got ${toBoundary}`,
        "INVALID_BOUNDARY",
      );
    }
    const live = this.live.getSession(id);

    if (live !== undefined) await this.live.flush(live);

    const internals = this.persistence.internals();

    // SessionBranch 是「先停止、再操作」的排他面（ADR 0003）：rewind 直连 DB 做最小工作，
    // 不走持久化抽象的全量读路径（readLog 会拉全部事件 + legacy 转换 + 读视图修复）。
    const row = await internals.backend.getSession(id);
    if (row === undefined) {
      throw new SessionBranchError(`session "${id}" not found`, "SESSION_NOT_FOUND");
    }
    const meta = rowToMeta(row);

    let rawKeepLength: number;
    let kept: readonly SessionEvent[] | undefined;
    if (isLegacyVersion(row.fVersion)) {
      // 旧格式的持久化坐标与当前视图 seq 不一致：只有这条路径需要读日志（含格式转换与读视图修复）
      const log = await this.persistence.readLog(id, {}, signal);
      if (log === undefined) {
        throw new SessionBranchError(`session "${id}" not found`, "SESSION_NOT_FOUND");
      }
      const boundaryType = log.events[toBoundary]?.type;
      assertRewindBoundary(id, toBoundary, boundaryType, log.events.length - 1);
      rawKeepLength =
        toBoundary === -1 ? 0 : boundaryType === "turn/end" ? toBoundary + 1 : toBoundary;
      kept = balanceRewindPrefix(log.events.slice(0, rawKeepLength));
    } else {
      const boundaryType =
        toBoundary === -1 ? undefined : await internals.backend.getEventTypeAt(id, toBoundary);
      assertRewindBoundary(id, toBoundary, boundaryType, row.fHeadSequence);
      rawKeepLength =
        toBoundary === -1 ? 0 : boundaryType === "turn/end" ? toBoundary + 1 : toBoundary;
    }
    const keepLength =
      kept === undefined
        ? await this.rewindKeepLength(id, rawKeepLength, internals.backend)
        : kept.length;
    if (keepLength < rawKeepLength) {
      this.live.warn?.(
        `session-rdb: rewind "${id}" dropped ${rawKeepLength - keepLength} trailing event(s) from seq ${keepLength} to keep the retained prefix's step pairs balanced`,
      );
    }

    const denseBoundary = keepLength - 1;
    const newSeedLength = await internals.backend.transaction(async (tx) => {
      signal?.throwIfAborted();
      const head = await tx.getHead(id);
      if (denseBoundary > head.fHeadSequence) {
        throw new SessionBranchError(
          `rewind boundary ${toBoundary} is beyond the stored head ${head.fHeadSequence}`,
          "INVALID_BOUNDARY",
        );
      }
      if (denseBoundary < head.fHeadSequence) {
        await tx.deleteBridgeTail(id, denseBoundary + 1);
        const prev = denseBoundary === -1 ? undefined : await tx.getPrevBridge(id, denseBoundary);
        if (prev === undefined) {
          await tx.updateHead(id, "", -1);
        } else {
          await tx.updateHead(id, prev.fEventId, prev.fSequence);
        }
      }

      const storedSeedLength = await tx.getSeedLength(id);
      let shrunk = storedSeedLength;
      if (storedSeedLength !== null && storedSeedLength > denseBoundary + 1) {
        await tx.updateSeedLength(id, denseBoundary + 1);
        shrunk = denseBoundary + 1;
      }

      await tx.refreshTitle(id);
      await tx.bumpRevision(id);
      return shrunk;
    });

    internals.writeGuard.confirmHead(id, denseBoundary);

    if (live !== undefined) {
      truncateLiveSession(live, keepLength);

      this.live.resetProjections?.(live);

      this.live.resetTokenMeter?.(live);
      const agent = this.live.getAgent(id);
      if (agent !== undefined) {
        agent.requestHeaderLogged = false;

        const lastTurn =
          live.snapshotEvents().findLast((e) => e.type === "turn/start")?.data.turn ?? 0;
        const phase = (agent as unknown as { phase?: { lastTurn?: number } }).phase;
        if (phase !== undefined) phase.lastTurn = lastTurn;
      }

      const handle = this.persistence.tracker.writerOf(id);
      if (handle !== undefined) {
        handle.resetAfterRewind(keepLength, newSeedLength === null ? undefined : newSeedLength);
      }

      agent?.inbox?.clear();

      await this.live.flush(live);

      await this.refreshProjectionCache(live);
    } else {
      // rewind 不读日志：缓存行按新水位截断（保留下来的投影单元仍在截断前缀内）
      await this.refreshProjectionCache({
        id,
        header: meta,
        inheritedEventCount: SessionLogOffset(newSeedLength ?? row.fSeedLength ?? 0),
        headSeq: keepLength - 1,
        snapshotEvents: () => [],
      });
    }

    return { header: rowToMeta(row), revision: (await internals.readStoredRevision(id))! };
  }

  // 保留长度只依赖尾部窗口：从 rawKeepLength 往回读类型（有界），窗口没覆盖到最近一个 turn/end
  // 就翻倍重读，直到覆盖或到达前缀开头。
  private async rewindKeepLength(
    id: SessionId,
    rawKeepLength: number,
    backend: Backend,
  ): Promise<number> {
    if (rawKeepLength === 0) return 0;
    let limit = 64;
    for (;;) {
      const rows = await backend.getEventTypesBefore(id, rawKeepLength, limit);
      const types = [...rows].reverse().map((row) => row.fType);
      const windowStart = rawKeepLength - types.length;
      if (types.includes("turn/end") || windowStart === 0 || types.length >= rawKeepLength) {
        return rewindKeepLength(types, rawKeepLength);
      }
      limit *= 4;
    }
  }

  private async refreshProjectionCache(session: ProjectionCacheSession): Promise<void> {
    if (this.live.refreshProjectionCache === undefined) return;
    try {
      await this.live.refreshProjectionCache(session);
    } catch {}
  }
}

export class SessionBranchRdb extends SessionBranch {
  static inject = ["sessionPersistence", "sessions"];

  private readonly warned = new Set<string>();

  constructor(ctx: import("@deepseek-ai/cordis").Context) {
    super(ctx);
  }

  // 覆盖导入等整段替换内存 log 的路径复用 rewind 的失效钩子（token-meter 水位是位置不是事件身份）
  resetLiveDerivedState(session: Session): void {
    this.resetProjectionCells(session);
    this.resetTokenMeterFold(session);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.logger.warn(message);
  }

  private resetProjectionCells(session: Session): void {
    const registry = (this.ctx as unknown as { get(name: string): unknown }).get(
      "sessionProjections",
    ) as ProjectionRegistryLike | undefined;
    const registrations = registry?.registrations;
    if (!(registrations instanceof Map)) {
      this.warnOnce(
        "sessionProjections.registrations",
        `session-rdb: ctx.sessionProjections.registrations is not a Map (upstream field shape changed); rewind leaves the projection cell caches of "${session.id}" stale, so replayed events can be skipped`,
      );
      return;
    }
    for (const registration of registrations.values()) {
      const cells = registration?.cells;
      if (!(cells instanceof WeakMap)) {
        this.warnOnce(
          "sessionProjections.cells",
          `session-rdb: ctx.sessionProjections registration cells are not a WeakMap (upstream field shape changed); rewind leaves the projection cell caches of "${session.id}" stale, so replayed events can be skipped`,
        );
        continue;
      }
      cells.delete(session);
    }
  }

  private resetTokenMeterFold(session: Session): void {
    const meter = this.ctx.get("tokenMeter") as TokenMeterLike | undefined;
    if (meter === undefined) {
      this.warnOnce(
        "tokenMeter",
        `session-rdb: ctx.tokenMeter is not mounted; after rewind the token-meter fold watermark of "${session.id}" may stay stale, so compaction can report "step/end ... has no matching step/start event"`,
      );
      return;
    }
    const states = meter.states;
    if (!(states instanceof WeakMap)) {
      this.warnOnce(
        "tokenMeter.states",
        `session-rdb: ctx.tokenMeter.states is not a WeakMap (upstream field shape changed); after rewind the token-meter fold watermark of "${session.id}" may stay stale, so compaction can report "step/end ... has no matching step/start event"`,
      );
      return;
    }
    states.delete(session);
  }

  private readonly provider = new SessionBranchRdbProvider(
    this.ctx.sessionPersistence as SessionPersistenceRdb,
    {
      getSession: (id) => this.ctx.sessions.get(id),
      getAgent: (id) => {
        const agents = this.ctx.get("agents") as
          | { get(id: SessionId): LiveAgentLike | undefined }
          | undefined;
        return agents?.get(id);
      },
      flush: (session) => this.ctx.sessions.flush(session),
      warn: (message) => {
        this.ctx.logger.warn(message);
      },
      resetProjections: (session) => this.resetProjectionCells(session),
      resetTokenMeter: (session) => this.resetTokenMeterFold(session),
      refreshProjectionCache: async (session) => {
        const cache = this.ctx.get("sessionProjectionCache") as
          | {
              write(session: ProjectionCacheSession): Promise<void>;
              truncateTo?(
                header: SessionHeader,
                inheritedEventCount: SessionLogOffset,
                headSeq: number,
              ): Promise<void>;
            }
          | undefined;
        if (cache === undefined) return;
        try {
          if (session.headSeq !== undefined && cache.truncateTo !== undefined) {
            await cache.truncateTo(session.header, session.inheritedEventCount, session.headSeq);
            return;
          }
          await cache.write(session);
        } catch (error: unknown) {
          this.ctx.logger.warn(
            `session-rdb: projection cache refresh after rewind for "${session.id}" failed (cache stays stale): ${String(error)}`,
          );
        }
      },
    },
  );

  readBranchPrefix(
    id: SessionId,
    atSeq?: number,
    mode?: BranchAnchorMode,
    signal?: AbortSignal,
  ): Promise<BranchBoundary> {
    return this.provider.readBranchPrefix(id, atSeq, mode, signal);
  }

  readRawEvents(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
    return this.provider.readRawEvents(id, signal);
  }

  forkFrom(
    sourceId: SessionId,
    options?: ForkFromOptions,
    signal?: AbortSignal,
  ): Promise<SessionId> {
    return this.provider.forkFrom(sourceId, options, signal);
  }

  rewind(
    id: SessionId,
    toBoundary: number,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot> {
    return this.provider.rewind(id, toBoundary, signal);
  }

  async timeline(sessionId: SessionId, signal?: AbortSignal) {
    const persistence = this.ctx.sessionPersistence as SessionPersistenceRdb;
    const snapshots = await persistence.listSnapshots(signal);

    const readOwnEvents = async (id: SessionId, fromSeq: number, s?: AbortSignal) => {
      const live = this.ctx.sessions.get(id);
      if (live !== undefined) return live.snapshotEvents().slice(fromSeq);
      return (await persistence.internals().readFrom(id, fromSeq, s)).events;
    };
    return buildTimeline(snapshots, readOwnEvents, sessionId, signal);
  }
}

export default SessionBranchRdb;
