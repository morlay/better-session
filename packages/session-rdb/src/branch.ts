/**
 * RDB 的「额外 provider 抽象」实现：在 `@morlay/session-rdb`
 * 既有 `PersistenceBackend`（append-only 面）之上，实现
 * `@morlay/session-branch` 的 `SessionBranchProvider`（分支面：rewind /
 * forkFrom / readBranchPrefix），并发布 `ctx.sessionBranch` 服务
 * （`SessionBranchRdb extends SessionBranch`）——使本包成为 rewind /
 * retry / fork 的持久化闭环。
 *
 * 关键设计（不改上游代码）：
 *
 * - `forkFrom` 走**标准 coordinator 路径**（`create` + `append`）：派生是纯
 *   append（新 id / parentSession / seedLength），上游 `PersistenceCoordinator`
 *   天然支持；seed 前缀按新会话 log 重新编号（保序重编号，`sourceEventSeqs`
 *   的相对序不变，`source < seq` 校验成立）。
 * - `rewind` 是上游没有的原语（`PersistenceCoordinator` 只有 append-only +
 *   torn-tail 修复），因此直接操作本后端的 `Backend` 事务（DELETE 尾部 +
 *   head 游标回退 + revision bump），随后**重新 load 同步 coordinator 状态**
 *   （revision 变化使 `isPreparedSourceCurrent` 失效 → 重新 adopt →
 *   `state.cursor` 与新尾部一致）并更新 `WriteGuard` 确认 head。
 * - 独占条件：无 live owner（`ctx.sessions.get(id) === undefined`）。prepared
 *   reservation 无法从公开 API 查询，rewind 通过 revision 变化使其自然失效。
 *
 * @module @morlay/session-rdb/branch
 */

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

/**
 * 定位 `atSeq` 锚定的闭合 `turn/end` 边界 seq。见
 * {@link SessionBranchProvider.readBranchPrefix} 的锚定语义说明。
 * @param events - 完整（或前缀）事件列表，seq 连续。
 * @param atSeq - 锚定 seq（inclusive）；省略取最后闭合轮次。
 * @param mode - `"after"`（默认）或 `"before"`。
 * @returns 边界事件 seq；`"before"` 模式下 atSeq 之前无闭合轮次时返回 -1
 *   （空前缀）。
 */
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

/** 按新会话 log 重新编号：保序重编号，`sourceEventSeqs` 相对序不变。 */
function renumber(events: readonly SessionEvent[], offset: number): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: offset + index }) as SessionEvent);
}

/** 派生会话 id（后端 mint 策略，与 apiproxy `session-<uuid>` 一致）。 */
function mintSessionId(): SessionId {
  return `session-${randomUUID()}` as SessionId;
}

/**
 * live rewind 所需的「live 会话/agent」最小访问面。上游 `Session` 是
 * append-only、缓存增量式对象，无公开截断方法；`PersistenceCoordinator`
 * 的 `states` 是私有 Map。这些是**运行时最小侵入**（不改上游源码，仅在
 * 编排层操作编译后对象字段），由 `SessionBranchRdb` 注入。
 */
export interface LiveSessionHooks {
  /** 查当前 live 会话（`ctx.sessions.get`）。 */
  getSession(id: SessionId): Session | undefined;
  /** 查当前 live agent（`ctx.agents?.get`，agents 服务可选）。 */
  getAgent(id: SessionId): LiveAgentLike | undefined;
  /** 立即落盘 live 会话的 write-behind 缓冲（`ctx.sessions.flush`）。 */
  flush(session: Session): Promise<boolean>;
  /**
   * 截断后同步 coordinator 的会话内存状态：把 `states` 条目的 `cursor`
   * 对齐到新的尾部（= boundary + 1），使下一次 append 的 seq 连续性校验
   * 通过。**不能**删除 `states` 条目——live 会话的下一次 append 若走
   * `adopt` 会经 `SessionStore.prepare` 构造 detached session，与 store 中
   * 的 live entry 冲突。
   */
  setCoordinatorCursor(id: SessionId, cursor: number): void;
  /**
   * 截断后同步 coordinator 的 ownerless 状态（cold 分支）：把 `states` 条目
   * 的 `cursor` 对齐到新尾部。与 {@link setCoordinatorCursor} 的区别是
   * **不要求条目已存在**——cold 会话可能从未被 adopt（无 states 条目），
   * 此时创建 ownerless 条目（meta 来自截断后快照），使下一次 append 走
   * 标准路径而非 `adopt`（adopt 会经 `prepareCore` 补 closers 撤销截断）。
   */
  setCoordinatorState(id: SessionId, cursor: number, meta: SessionHeader): void;
}

/** agent 的最小 live 形态：持有同一会话 + 可重置请求头日志标记。 */
export interface LiveAgentLike {
  session: Session;
  /** 编译后字段：是否已 append 过首个 `request/header`（截断后需重置）。 */
  requestHeaderLogged?: boolean;
}

/**
 * 截断 live 会话的内存 log 并重置全部派生缓存。上游 `Session` 的
 * `log`/`surfaceManager`/`headerFold`/`contextFold`/`derived` 都是增量缓存：
 * 截断 `log` 后必须同步重置，否则下一次 append 会基于陈旧状态校验/投影。
 * 字段名取编译后产物（`@deepseek-ai/dsh-session` lib），并对
 * `SurfaceManager`（持有同一 `log` 数组引用）做全量重折叠复位——
 * `_lastProcessedSeq = baseSeq - 1` 使下次访问重新 fold 整个截断后 log。
 */
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

/**
 * 用导入的事件整体替换 live 会话的内存 log 并重置全部派生缓存（覆盖导入
 * 的 host 端同步：rewind(-1) 已把 live log 截断为空，DB 由 append 写入，
 * 此处把同一批事件灌回 live 内存，使 `observeSession` 的 live 快照与 DB
 * 一致——否则 UI 刷新重读仍命中空快照）。与 {@link truncateLiveSession}
 * 同模式：不发布事件、不重复落库；`surfaceManager` 全量重折叠复位。
 * @param session - live 会话。
 * @param events - 导入事件（稠密 seq 0..n-1）。
 */
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

/**
 * RDB 分支数据层实现（`SessionBranchProvider`）。与 `SessionPersistenceRdb`
 * 共享同一数据库连接（`Backend`）与 coordinator 写路径。
 */
export class SessionBranchRdbProvider implements SessionBranchProvider {
  readonly name = "session-rdb";

  constructor(
    private readonly persistence: SessionPersistenceRdb,
    /** live 会话/agent 访问面（rewind 支持 live session 时使用）。 */
    private readonly live: LiveSessionHooks = {
      getSession: () => undefined,
      getAgent: () => undefined,
      flush: async () => true,
      setCoordinatorCursor: () => {},
      setCoordinatorState: () => {},
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

  /**
   * 读取会话的**原始**事件（不含 coordinator 补记的合成 closers）。
   *
   * `persistence.inspect` 走 coordinator 的 `prepareCore`，会给未闭合 log
   * 补 `interruptedTurnClosers`（合成 step/end + turn/end）——对普通读取
   * （客户端历史）这是正确的逻辑视图，但对分支编排是误导：未闭合轮次被
   * closers 掩盖成闭合，编辑未闭合轮次的 user 消息会走错边界。这里用
   * `loadStored`（backend hook，scanRows 只做 torn-tail 切割、不补 closers）
   * 读原始事件，使未闭合状态真实可见。
   */
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
    // live 会话先把 write-behind 缓冲全部落盘（RDB = live 内存全量），保证
    // 后续读取与后端事务（读 RDB head）基于同一视图。
    if (live !== undefined) await this.live.flush(live);
    // 边界校验：toBoundary 是已存在事件且为 turn/end 或 user/message。
    // 用**原始**事件（loadStored，不补 closers）——`inspect` 会经 coordinator
    // 的 `prepareCore` 给未闭合 log 补合成 step/end + turn/end，把 user/message
    // 边界掩盖成 turn/end，导致 exclusive 语义丢失。
    const raw = live === undefined ? await this.readRawEvents(id, signal) : undefined;
    const inspection = live === undefined ? undefined : await this.persistence.inspect(id, signal);
    const events = live === undefined ? raw!.events : inspection!.events;
    const meta = live === undefined ? raw!.meta : inspection!.meta;
    const boundaryEvent = events[toBoundary];
    if (toBoundary === -1) {
      // 空前缀：允许回退到「任何轮次之前」= 清空整个 log 的前置（head 归 -1）。
      // 与 commitRepair 的「head 回退到初始状态」语义一致。
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
    // 保留前缀长度（上游坐标）：turn/end 保留到该事件（inclusive）；user/message
    // drop 该消息及其后（exclusive）——编辑重放语义，边界消息由编辑版替换。
    // 随后平衡化：真实 agent-loop 的 step/start 在 user/message 之前，exclusive
    // 截断会残留未配对的 step/start（其 step/end 在 drop 区）——token meter
    // 重放要求 step/start 配对，因此从尾部剔除孤儿 step/start（见
    // balanceRewindPrefix）。
    const rawKeepLength =
      toBoundary === -1 ? 0 : boundaryEvent!.type === "turn/end" ? toBoundary + 1 : toBoundary;
    const keepLength = balanceRewindPrefix(events.slice(0, rawKeepLength)).length;

    const internals = this.persistence.internals();
    // —— 坐标换算：上游 seq（live log / 编排层 boundary）→ RDB 稠密 seq ——
    // live 会话的 `inspection.events` 是内存 log 的上游 seq：delta 事件
    // （assistant/chunk）与 ignorable 事件（版本效果）也占用连续 seq，而
    // RDB 只在写路径持久化 survived 事件并稠密重编号（f_sequence），
    // `head.fHeadSequence` 是稠密坐标。rewind 的 boundary 来自编排层基于
    // live log 计算的上游 seq，必须映射为 RDB 的删除目标 = 前缀中
    // persisted 事件数 - 1；否则「boundary > stored head」恒误报（上游
    // head 永远大于稠密 head）。cold 视图本身已是稠密 seq，直接使用。
    const denseBoundary =
      live === undefined
        ? keepLength - 1
        : events.slice(0, keepLength).filter(isPersistedEvent).length - 1;
    await internals.backend.transaction(async (tx) => {
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
      await tx.bumpRevision(id);
    });

    // 更新本实例的确认 head（下一次 append 的并发校验基准）——稠密坐标，
    // 与 `appendBatch` 内 `confirmHead` 的稠密语义一致。
    internals.writeGuard.confirmHead(id, denseBoundary);

    if (live !== undefined) {
      // live 分支：截断内存 log 并重置派生缓存；同步 coordinator 的
      // state.cursor（保留 owner，下一次 append 的 seq 校验续接截断后
      // 尾部）；重置 agent 的请求头标记（截断可能删掉最后一条
      // request/header，让 agent 下次补记）。不调用 `load`——live 时 load
      // 会先 flush 把旧内存写回，撤销本次截断。
      truncateLiveSession(live, keepLength);
      const agent = this.live.getAgent(id);
      if (agent !== undefined) {
        agent.requestHeaderLogged = false;
        // 同步 agent 的轮次游标：截断后 session 的最后一个 turn 号。live
        // agent 驻留不重建，其 `phase.lastTurn` 仍是编辑前的值——不重置的话
        // 重放（followup）会继续递增产生**新**轮次号（如重试 turn 2 得到
        // turn 3），而不是复用目标轮号。
        const lastTurn =
          live.snapshotEvents().findLast((e) => e.type === "turn/start")?.data.turn ?? 0;
        const phase = (agent as unknown as { phase?: { lastTurn?: number } }).phase;
        if (phase !== undefined) phase.lastTurn = lastTurn;
      }
      this.live.setCoordinatorCursor(id, keepLength);
    } else {
      // cold 分支：同步 coordinator 状态。
      // - turn/end 边界：截断后 log 平衡（停在闭合轮次末尾），load 的
      //   repair 为 no-op，经 revision 变化重新 adopt 使 state.cursor 与
      //   新尾部一致；
      // - user/message 边界：截断后 log 停在 turn/start（不平衡），load 的
      //   `prepareCore` 会用 `interruptedTurnClosers` 补 closers 并 commitRepair
      //   落盘——把被 drop 的 user/message 的 seq 位置占掉，撤销截断语义。
      //   因此直接同步 ownerless states 条目（cursor = keepLength），下一次
      //   append 走标准路径而非 adopt。
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

/**
 * RDB 的 `ctx.sessionBranch` 服务：组合 {@link SessionBranchRdbProvider} 的
 * 数据层原语与共享版本树投影。插件把本类注册为 `sessionBranch` 服务后，
 * 编排层即可通过统一服务面完成 rewind / retry / fork。
 */
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
        // coordinator 的 states 是私有 Map；保留条目（owner 不能丢），仅把
        // cursor 对齐到截断后的新尾部，使下一次 append 的 seq 校验续接。
        const persistence = this.ctx.sessionPersistence as unknown as {
          coordinator?: {
            states?: Map<SessionId, { cursor: number } | undefined>;
          };
        };
        const state = persistence.coordinator?.states?.get(id);
        if (state !== undefined) state.cursor = cursor;
      },
      setCoordinatorState: (id, cursor, meta) => {
        // cold 分支（user/message 边界）：states 条目可能不存在（会话从未
        // 被 adopt）。存在则仅对齐 cursor；不存在则创建 ownerless 条目
        // （meta 来自截断后快照），使下一次 append 走标准路径而非 adopt
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

  /**
   * 读取会话的**原始**事件（不含 coordinator 补记的合成 closers）。
   * 编排层用它识别未闭合轮次（inspect 会把未闭合 log 补成闭合）。
   */
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

  /**
   * 清洗一个 session 的 surface/provenance 坐标到稠密空间（持久化层透传）。
   * 旧数据（rewind 前写入）的 sourceEventSeqs / surfaceOp / shadowedRange
   * 是上游坐标,读取时每次都要对齐;清洗一次性写回稠密坐标,之后读取无需
   * 对齐。返回实际变更的事件数。
   */
  cleanseSession(sessionId: SessionId, signal?: AbortSignal): Promise<{ changed: number }> {
    return (this.ctx.sessionPersistence as SessionPersistenceRdb).cleanseSession(sessionId, signal);
  }

  /**
   * 同步 live 会话的 coordinator 内存 cursor，跳过 ignorable 占位事件。
   * 编排层在 rewind 后把 ignorable 版本效果 push 进 live log（不发布、不
   * 进缓冲）——它占用一个上游 seq，但 coordinator 的 cursor（rewind 设到
   * 截断后长度）看不见它；不跳过的话，flush 的 `appendLiveBatch` 会以
   * `e.seq >= cursor` 过滤掉 cursor 之前的事件（manualTurn 永远不落盘），
   * 或 `appendCore` 的 seq 连续性校验错位。这里把 cursor 从当前值起跳过
   * 连续的 ignorable 事件，对齐到下一个待持久化事件的 seq。
   */
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
    // 走持久化 readFrom——版本效果不落 canonical log（ignorable 语义），
    // cold timeline 退化为 lineage 骨架（无效果详情）。
    const readOwnEvents = async (id: SessionId, fromSeq: number, s?: AbortSignal) => {
      const live = this.ctx.sessions.get(id);
      if (live !== undefined) return live.snapshotEvents().slice(fromSeq);
      return (await persistence.readFrom(id, fromSeq, s)).events;
    };
    return buildTimeline(snapshots, readOwnEvents, sessionId, signal);
  }
}

export default SessionBranchRdb;
