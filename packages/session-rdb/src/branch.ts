import {
  SESSION_FORMAT_VERSION,
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
  type BranchAnchorMode,
  type BranchBoundary,
  type ForkFromOptions,
  type SessionBranchProvider,
} from "@morlay/session-branch";
import { randomUUID } from "node:crypto";
import type { SessionPersistenceRdb } from "./index.ts";
import { rowToMeta } from "./log.ts";
import { isPersistedEvent } from "./schema.ts";

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
  // atSeq 越过末尾：若其落在未闭合轮内则拒绝，否则回退最后一个闭合轮。
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

  setCoordinatorCursor(id: SessionId, cursor: number): void;

  setCoordinatorState(id: SessionId, cursor: number, meta: SessionHeader): void;

  setCoordinatorSeedLength(id: SessionId, seedLength: number): void;
}

export interface LiveAgentLike {
  session: Session;

  requestHeaderLogged?: boolean;
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
    surfaceManager: {
      _state: { nodes: number[]; replaceGeneration: number };
      _lastProcessedSeq: number;
      _pendingPlan?: unknown;
      baseSeq: number;
    };
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
  s.surfaceManager._state = { nodes: [], replaceGeneration: 0 };
  s.surfaceManager._lastProcessedSeq = s.surfaceManager.baseSeq - 1;
  s.surfaceManager._pendingPlan = undefined;
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
    surfaceManager: {
      _state: { nodes: number[]; replaceGeneration: number };
      _lastProcessedSeq: number;
      _pendingPlan?: unknown;
      baseSeq: number;
    };
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
  s.surfaceManager._state = { nodes: [], replaceGeneration: 0 };
  s.surfaceManager._lastProcessedSeq = s.surfaceManager.baseSeq - 1;
  s.surfaceManager._pendingPlan = undefined;
}

export class SessionBranchRdbProvider implements SessionBranchProvider {
  readonly name = "session-rdb";

  constructor(
    private readonly persistence: SessionPersistenceRdb,

    private readonly live: LiveSessionHooks = {
      getSession: () => undefined,
      getAgent: () => undefined,
      flush: async () => true,
      setCoordinatorCursor: () => {},
      setCoordinatorState: () => {},
      setCoordinatorSeedLength: () => {},
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
    const stored = await this.persistence.loadStored(id, signal);
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
    const source = await this.persistence.inspect(sourceId, signal);
    const boundary = locateTurnEnd(source.events, atSeq, anchorMode);
    const prefix = source.events.slice(0, boundary + 1);
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
    // 事件行复用：前缀事件（上游 seq → 源会话已存在事件行 id）注册到写路径，
    // appendBatch 消费时复用事件行、不复制。seedSuffix 的 manualTurn 事件是
    // 新事件（无源行），不注册。
    const internals = this.persistence.internals();
    const sourceRows = await internals.backend.getEventRows(sourceId);
    const sourceEventIds = new Map(sourceRows.map((row) => [row.fOriginalSeq, row.fEventId]));
    const reuse = new Map<number, string>();
    for (const event of prefix) {
      const eventId = sourceEventIds.get(event.seq);
      if (eventId !== undefined) reuse.set(event.seq, eventId);
    }
    internals.registerReuseEventIds(childId, reuse);
    await this.persistence.create(childMeta, prefix.length);
    if (seed.length > 0) await this.persistence.append(childId, seed);
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
    // live 会话先落盘 write-behind 缓冲，保证后续读取与后端事务同视图。
    if (live !== undefined) await this.live.flush(live);
    // 边界校验用原始事件（loadStored，不补 closers）——inspect 会给未闭合
    // log 补合成 closers，把 user/message 边界掩盖成 turn/end，丢失 exclusive
    // 语义。
    const raw = live === undefined ? await this.readRawEvents(id, signal) : undefined;
    const inspection = live === undefined ? undefined : await this.persistence.inspect(id, signal);
    const events = live === undefined ? raw!.events : inspection!.events;
    const meta = live === undefined ? raw!.meta : inspection!.meta;
    const boundaryEvent = events[toBoundary];
    if (toBoundary === -1) {
      // 空前缀：清空整个 log（head 归 -1），与 commitRepair 的初始状态一致。
    } else if (boundaryEvent === undefined) {
      throw new SessionBranchError(
        `rewind boundary ${toBoundary} does not exist in session "${id}"`,
        "INVALID_BOUNDARY",
      );
    } else if (boundaryEvent.type !== "turn/end" && boundaryEvent.type !== "user/message") {
      throw new SessionBranchError(
        `rewind boundary ${toBoundary} is not a turn/end or user/message (${boundaryEvent.type})`,
        "INVALID_BOUNDARY",
      );
    }
    // 保留前缀长度：turn/end inclusive；user/message exclusive（边界消息由
    // 编辑版替换）。exclusive 截断可能残留孤儿 step/start，经平衡化剔除。
    const rawKeepLength =
      toBoundary === -1 ? 0 : boundaryEvent!.type === "turn/end" ? toBoundary + 1 : toBoundary;
    const keepLength = balanceRewindPrefix(events.slice(0, rawKeepLength)).length;

    const internals = this.persistence.internals();
    // live 视图是上游 seq（含被过滤的 delta），RDB head 是稠密 seq——live
    // 边界须换算为前缀中 persisted 事件数 - 1；cold 视图本身已是稠密 seq。
    const denseBoundary =
      live === undefined
        ? keepLength - 1
        : events.slice(0, keepLength).filter(isPersistedEvent).length - 1;
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
      // 截断进入继承前缀后收缩 f_seed_length（只收缩、不扩张），防止存储
      // 出现「继承前缀超过存储事件数」的矛盾（上游 load 判损坏）。
      const storedSeedLength = await tx.getSeedLength(id);
      let shrunk = storedSeedLength;
      if (storedSeedLength !== null && storedSeedLength > denseBoundary + 1) {
        await tx.updateSeedLength(id, denseBoundary + 1);
        shrunk = denseBoundary + 1;
      }
      await tx.bumpRevision(id);
      return shrunk;
    });
    // 同步 coordinator 的 storage.inheritedEventCount——DB 已收缩而内存不
    // 收缩的话，下一次 append 的 upsert 会把旧值覆盖回去。
    if (newSeedLength !== null) {
      this.live.setCoordinatorSeedLength(id, newSeedLength);
    }

    // 更新确认 head（下一次 append 的并发校验基准），与 appendBatch 同语义。
    internals.writeGuard.confirmHead(id, denseBoundary);

    if (live !== undefined) {
      // live 分支：截断内存 log 并重置派生缓存；同步 coordinator cursor 与
      // agent 轮次游标。不调用 load——live 时 load 会先 flush 把旧内存写回，
      // 撤销本次截断。
      truncateLiveSession(live, keepLength);
      const agent = this.live.getAgent(id);
      if (agent !== undefined) {
        agent.requestHeaderLogged = false;
        // 重置 agent 的轮次游标，使重放（followup）复用目标轮号而非递增。
        const lastTurn =
          live.snapshotEvents().findLast((e) => e.type === "turn/start")?.data.turn ?? 0;
        const phase = (agent as unknown as { phase?: { lastTurn?: number } }).phase;
        if (phase !== undefined) phase.lastTurn = lastTurn;
      }
      this.live.setCoordinatorCursor(id, keepLength);
    } else {
      // cold 分支：user/message 边界直接同步 ownerless states 条目（load 会
      // 补 closers 撤销截断语义）；turn/end 边界经 load 重新 adopt。
      if (boundaryEvent?.type === "user/message") {
        this.live.setCoordinatorState(id, keepLength, meta);
      } else {
        await this.persistence.load(id);
      }
    }

    const row = await internals.backend.getSession(id);
    if (row === undefined) {
      // 空会话（toBoundary = -1 且从未有行）：返回「已确认缺席」快照。
      return {
        header: {
          version: SESSION_FORMAT_VERSION,
          id,
          createdAt: meta.createdAt,
          ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
          ...(meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {}),
          isSeeded: meta.isSeeded,
          ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
          ...(meta.delegationDepth !== undefined ? { delegationDepth: meta.delegationDepth } : {}),
          ...(meta.agentPreset !== undefined ? { agentPreset: meta.agentPreset } : {}),
        },
        revision:
          (await internals.readStoredRevision(id)) ??
          (await this.persistence.readStoredRevision(id))!,
      };
    }
    return { header: rowToMeta(row), revision: (await internals.readStoredRevision(id))! };
  }
}

export class SessionBranchRdb extends SessionBranch {
  static inject = ["sessionPersistence", "sessions"];

  constructor(ctx: import("@deepseek-ai/cordis").Context) {
    super(ctx);
  }

  private readonly provider = new SessionBranchRdbProvider(
    this.ctx.sessionPersistence as SessionPersistenceRdb,
    {
      getSession: (id) => this.ctx.sessions.get(id),
      getAgent: (id) => {
        // agents 服务可选（纯持久化环境无 agent-loop）：经 ctx.get 动态访问。
        const agents = this.ctx.get("agents") as
          | { get(id: SessionId): LiveAgentLike | undefined }
          | undefined;
        return agents?.get(id);
      },
      flush: (session) => this.ctx.sessions.flush(session),
      setCoordinatorCursor: (id, cursor) => {
        // states 是私有 Map；保留条目（owner 不能丢），仅对齐 cursor 到新尾部。
        const persistence = this.ctx.sessionPersistence as unknown as {
          coordinator?: {
            states?: Map<SessionId, { cursor: number } | undefined>;
          };
        };
        const state = persistence.coordinator?.states?.get(id);
        if (state !== undefined) state.cursor = cursor;
      },
      setCoordinatorState: (id, cursor, meta) => {
        // states 条目可能不存在（会话从未被 adopt）；存在则仅对齐 cursor，
        // 不存在则创建 ownerless 条目，使下一次 append 走标准路径而非 adopt
        // （adopt 会经 prepareCore 补 closers 撤销截断）。
        const persistence = this.ctx.sessionPersistence as unknown as {
          coordinator?: {
            states?: Map<
              SessionId,
              { cursor: number; meta: SessionHeader; materialized: boolean } | undefined
            >;
          };
        };
        const states = persistence.coordinator?.states;
        if (states === undefined) return;
        const state = states.get(id);
        if (state !== undefined) {
          state.cursor = cursor;
        } else {
          states.set(id, { meta, cursor, materialized: true });
        }
      },
      setCoordinatorSeedLength: (id, seedLength) => {
        // 收缩 storage.inheritedEventCount，与 DB 事务内的收缩保持一致——
        // 不同步的话下一次 append 的 upsert 会把旧值覆盖回去。storage 对象
        // 可能被冻结，整体替换 state.storage 而非改字段。
        const persistence = this.ctx.sessionPersistence as unknown as {
          coordinator?: {
            states?: Map<
              SessionId,
              | {
                  storage?: { meta: SessionHeader; inheritedEventCount: number };
                }
              | undefined
            >;
          };
        };
        const state = persistence.coordinator?.states?.get(id);
        if (state?.storage !== undefined && state.storage.inheritedEventCount > seedLength) {
          state.storage = { ...state.storage, inheritedEventCount: seedLength };
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

  syncLiveCursor(sessionId: SessionId): void {
    const live = this.ctx.sessions.get(sessionId);
    if (live === undefined) return;
    const persistence = this.ctx.sessionPersistence as unknown as {
      coordinator?: {
        states?: Map<SessionId, { cursor: number } | undefined>;
      };
    };
    const state = persistence.coordinator?.states?.get(sessionId);
    if (state === undefined) return;
    let cursor = state.cursor;
    // ignorable 是下游信封扩展（上游 SessionEvent 无此字段），结构化读取。
    while (
      (live.snapshotEvents()[cursor] as (SessionEvent & { ignorable?: unknown }) | undefined)
        ?.ignorable === true
    )
      cursor += 1;
    state.cursor = cursor;
  }

  async timeline(sessionId: SessionId, signal?: AbortSignal) {
    const persistence = this.ctx.sessionPersistence as SessionPersistenceRdb;
    const snapshots = await persistence.listSnapshots(signal);
    // live 会话从内存 log 读自有后缀（含 ignorable 版本效果事件）；cold 会话
    // 走持久化 readFrom（版本效果不落 canonical log，timeline 为 lineage 骨架）。
    const readOwnEvents = async (id: SessionId, fromSeq: number, s?: AbortSignal) => {
      const live = this.ctx.sessions.get(id);
      if (live !== undefined) return live.snapshotEvents().slice(fromSeq);
      return (await persistence.readFrom(id, fromSeq, s)).events;
    };
    return buildTimeline(snapshots, readOwnEvents, sessionId, signal);
  }
}

export default SessionBranchRdb;
