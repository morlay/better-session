import { Service, type Context } from "@deepseek-ai/cordis";
import type { AssistantMessage, UserMessage } from "@deepseek-ai/dsh-llm";
import type {
  Session,
  SessionEvent,
  SessionId,
  SurfaceEventType,
  SurfaceIntent,
} from "@deepseek-ai/dsh-session";
import {
  SessionBranchError,
  balanceRewindPrefix,
  type BranchBoundary,
  type BranchTimeline,
} from "@morlay/session-branch";
import type {
  EditOperation,
  EditableMessageBlock,
  RerollOperation,
  RetryOperation,
  RetryableTurn,
  SessionEditorResult,
} from "./types.ts";
import {
  SESSION_EDITOR_PATH,
  type SessionEditorOperation,
  type SessionEditorOperationResult,
  type SessionEditorTimeline,
  toTimelinePayload,
} from "./shared.ts";
import {
  closedTurns,
  editableMessages,
  editPlan,
  retryPlan,
  rerollPlan,
  retryableTurns,
} from "./plan.ts";

export type { CascadePolicy, EditableBlockKind } from "@morlay/session-branch";
export type {
  EditableMessageBlock,
  EditOperation,
  RerollOperation,
  RetryOperation,
  RetryableTurn,
  RewindOperation,
  SessionEditorOperation,
  SessionEditorResult,
} from "./types.ts";

export { closedTurns, editableMessages, retryableTurns };
export { SESSION_BRANCH_VERSION_SCHEMA } from "@morlay/session-branch";

export type { BranchTimeline, SessionBranchVersionEvent } from "@morlay/session-branch";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionEditor: SessionEditor;
  }
}

export interface EditorAgent {
  readonly session: Session;
  followup(message: UserMessage): void;
  /** 等待 agent 到达 quiescence（当前 turn/任务结束后 resolve）。 */
  whenIdle(): Promise<void>;
  /**
   * 队列中是否有待处理输入（next-turn / next-step）。rewind 截断会删除这些
   * 输入所属轮次的事件，残留的 inbox 状态会与截断后的 log 失配，使后续
   * splice 落库后无法从日志重放——编辑前必须清空。
   */
  readonly inboxPending: boolean;
  /** 清空待处理输入（落库 canceled splice，须在 rewind 前调用）。 */
  clearInbox(): void;
}

export interface EditorAgentHandle {
  readonly agent: EditorAgent;
  dispose(): Promise<void>;
}

export interface EditorAgentRegistry {
  get(sessionId: SessionId): EditorAgent | undefined;
  create(options: {
    sessionId?: SessionId;
    seed?: readonly SessionEvent[];
    meta?: {
      cwd?: string;
      parentSession?: SessionId;
      seedLength?: number;
      agentPreset?: string;
    };
    agentOptions?: { provider: string; model: string; maxTokens?: number };
  }): Promise<EditorAgentHandle>;

  resume(options: {
    resumeSessionId: SessionId;
    agentOptions?: { provider: string; model: string; maxTokens?: number };
  }): Promise<EditorAgentHandle>;
}

function appendLogSeedEvent(
  events: SessionEvent[],
  type: string,
  data: unknown,
  ignorable = false,
): void {
  events.push({
    type: type as SessionEvent["type"],
    seq: events.length,
    time: Date.now(),
    data: data as SessionEvent["data"],
    ...(ignorable ? { ignorable: true as const } : {}),
  } as SessionEvent);
}

function appendSurfaceSeedEvent<T extends SurfaceEventType>(
  events: SessionEvent[],
  type: T,
  data: import("@deepseek-ai/dsh-session").SessionEvent<T>["data"],
  intent: SurfaceIntent,
): void {
  events.push({
    type,
    seq: events.length,
    time: Date.now(),
    data,
    surfaceOp: intent.surfaceOp,
    ...(intent.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: intent.sourceEventSeqs }),
  } as SessionEvent<T>);
}

function appendManualTurn(
  events: SessionEvent[],
  manual: { turn: number; user: UserMessage; assistant: AssistantMessage },
): void {
  const { turn, user, assistant } = manual;
  appendLogSeedEvent(events, "turn/start", { turn });
  appendSurfaceSeedEvent(events, "user/message", user, { surfaceOp: "append" });
  appendLogSeedEvent(events, "step/start", { turn, step: 1 });
  appendSurfaceSeedEvent(
    events,
    "assistant/message",
    { turn, step: 1, message: assistant },
    {
      surfaceOp: "append",
      sourceEventSeqs: [],
    },
  );
  appendLogSeedEvent(events, "step/end", { turn, step: 1 });
  appendLogSeedEvent(events, "turn/end", {
    turn,
    reason: { kind: "completed" },
  });
}

function appendSeedSuffixLive(session: Session, seedSuffix: readonly SessionEvent[]): void {
  for (const event of seedSuffix) {
    // 版本效果事件携带 ignorable 标记（上游类型无此字段，duck-type 读取）。
    const ignorable = (event as { ignorable?: boolean }).ignorable === true;
    if (ignorable) {
      const s = session as unknown as {
        log: SessionEvent[];
        eventsSnapshot?: unknown;
      };
      // ignorable 语义：live log 保留、不落 canonical log。session.append 不
      // 保留 ignorable 标记，因此直接 push 内存 log（不发布）；seq 按 log
      // 续接重编号（seedSuffix 内部编号从 0 起）。
      s.log.push({ ...event, seq: s.log.length } as SessionEvent);
      s.eventsSnapshot = undefined;
      continue;
    }
    const s = session as unknown as {
      append(
        type: string,
        data: unknown,
        opts?: { surfaceOp?: unknown; sourceEventSeqs?: readonly number[] },
      ): SessionEvent;
    };
    const raw = event as SessionEvent & {
      surfaceOp?: unknown;
      sourceEventSeqs?: readonly number[];
    };
    if (raw.surfaceOp !== undefined) {
      s.append(event.type, event.data, {
        surfaceOp: raw.surfaceOp,
        ...(raw.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: raw.sourceEventSeqs }),
      });
    } else {
      s.append(event.type, event.data);
    }
  }
}

export class SessionEditor extends Service {
  static inject = ["sessionBranch", "sessionPersistence", "sessions"];

  constructor(ctx: Context) {
    super(ctx, "sessionEditor");
    // HTTP 路由随类构造注册（dsh 用 default 类插件，apply 不被调用）；
    // bundles 顺序保证 webserver 先于本类实例化。
    registerHttpRoutes(ctx);
  }

  readBranchPrefix(
    id: SessionId,
    atSeq?: number,
    mode?: "after" | "before",
    signal?: AbortSignal,
  ): Promise<BranchBoundary> {
    return this.ctx.sessionBranch.readBranchPrefix(id, atSeq, mode, signal);
  }

  fork(
    sourceId: SessionId,
    atSeq?: number,
    childSessionId?: SessionId,
    meta?: { cwd?: string; agentPreset?: string },
    signal?: AbortSignal,
  ): Promise<SessionId> {
    return this.ctx.sessionBranch.forkFrom(
      sourceId,
      {
        ...(atSeq === undefined ? {} : { atSeq }),
        ...(childSessionId === undefined ? {} : { childSessionId }),
        ...(meta === undefined ? {} : { meta }),
      },
      signal,
    );
  }

  rewind(id: SessionId, toBoundary: number, signal?: AbortSignal) {
    return this.ctx.sessionBranch.rewind(id, toBoundary, signal);
  }

  timeline(sessionId: SessionId, signal?: AbortSignal): Promise<BranchTimeline> {
    return this.ctx.sessionBranch.timeline(sessionId, signal);
  }

  edit(operation: EditOperation, signal?: AbortSignal): Promise<SessionEditorResult> {
    return this.branchOperation(operation, signal);
  }

  reroll(operation: RerollOperation, signal?: AbortSignal): Promise<SessionEditorResult> {
    return this.branchOperation(operation, signal);
  }

  retry(operation: RetryOperation, signal?: AbortSignal): Promise<SessionEditorResult> {
    return this.branchOperation(operation, signal);
  }

  async editableMessages(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<EditableMessageBlock[]> {
    const events = await this.readEvents(sessionId, signal);
    return editableMessages(closedTurns(events));
  }

  async retryableTurns(sessionId: SessionId, signal?: AbortSignal): Promise<RetryableTurn[]> {
    const events = await this.readEvents(sessionId, signal);
    return retryableTurns(closedTurns(events));
  }

  private async branchOperation(
    operation: EditOperation | RerollOperation | RetryOperation,
    signal?: AbortSignal,
  ): Promise<SessionEditorResult> {
    signal?.throwIfAborted();
    const events = await this.readEvents(operation.sessionId, signal);
    const turns = closedTurns(events);
    const plan =
      operation.action === "edit"
        ? editPlan(operation, turns)
        : operation.action === "retry"
          ? retryPlan(operation, turns)
          : rerollPlan(operation, turns);
    // rewind 前解析模型配置：就地编辑可能截断最后的 request/header
    // （编辑第一轮 boundary = -1 清空全部），重放 agent 需要 provider/model。
    const headerConfig = events.findLast((event) => event.type === "request/header")?.data.header
      .config;

    // 派生 seed 后缀：版本效果 + 可选手工回合。版本事件对核心是 ignorable，
    // 保证非 branch 读者可安全跳过。
    const seedSuffix: SessionEvent[] = [];
    appendLogSeedEvent(seedSuffix, "session-branch/version", plan.version, true);
    if (plan.manualTurn !== undefined) appendManualTurn(seedSuffix, plan.manualTurn);

    // 就地编辑：不创建新会话、不改变 id。需要重放排队输入时，先在 rewind
    // 前确保 agent 就绪（live agent 等其停；cold 先 resume）——rewind 截断后
    // agent 无法再以完整会话 resume，且重放失败不应让截断静默丢弃内容。
    const replay = await this.prepareReplay(
      operation.sessionId,
      plan.queuedUsers,
      signal,
      headerConfig,
    );

    const turnIndex = turns.findIndex((turn) => turn.startSeq === plan.anchorSeq);
    const boundary =
      plan.rewindBoundary !== undefined
        ? plan.rewindBoundary
        : turnIndex <= 0
          ? -1
          : turns[turnIndex - 1]!.endSeq!;
    const live = this.ctx.sessions.get(operation.sessionId);
    await this.ctx.sessionBranch.rewind(operation.sessionId, boundary, signal);
    if (seedSuffix.length > 0) {
      if (live !== undefined) {
        // live：版本效果 push 内存 log（ignorable 保留）、manualTurn 走 append，
        // 同步 cursor 后显式 flush（push 不发布、不进缓冲，cursor 会落后）。
        appendSeedSuffixLive(live, seedSuffix);
        this.ctx.sessionBranch.syncLiveCursor(operation.sessionId);
        await this.ctx.sessions.flush(live);
      } else {
        // cold：续写 seq 从平衡后的保留前缀接续（exclusive 截断可能残留
        // 孤儿 step/start，落盘 log 对 token meter 重放非法）。
        const rawKeepLength = boundary + (plan.rewindBoundary === undefined ? 1 : 0);
        const keepLength = balanceRewindPrefix(events.slice(0, rawKeepLength)).length;
        const renumbered = seedSuffix.map(
          (event, index) =>
            ({
              ...event,
              seq: keepLength + index,
            }) as SessionEvent,
        );
        await this.ctx.sessionPersistence.append(operation.sessionId, renumbered);
      }
    }

    // 发起新的 user prompt：把排队输入交给就绪的 agent（rewind 后其 session
    // 已被截断，followup 基于截断后历史开新轮重放）。无 agent（agents 服务
    // 缺失）时退化为已 durable 的就地版本。
    let queuedTurns = 0;
    if (replay.agent !== undefined && plan.queuedUsers.length > 0) {
      for (const message of plan.queuedUsers) replay.agent.followup(message);
      await this.ctx.sessions.flush(replay.agent.session);
      queuedTurns = plan.queuedUsers.length;
    }
    return {
      sessionId: operation.sessionId,
      queuedTurns,
      // 操作后是否仍有 live owner（prepareReplay 可能 resume 出 agent）。
      live: this.ctx.sessions.get(operation.sessionId) !== undefined,
    };
  }

  private async readEvents(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<readonly SessionEvent[]> {
    const live = this.ctx.sessions.get(sessionId);
    if (live !== undefined) return live.snapshotEvents();
    // cold：读原始事件（loadStored 不补 closers）——inspect 会把未闭合 log
    // 补成闭合，编辑未闭合轮次的 user 消息会走错边界。
    const branch = this.ctx.sessionBranch as unknown as {
      readRawEvents(
        id: SessionId,
        signal?: AbortSignal,
      ): Promise<{ meta: unknown; events: readonly SessionEvent[] }>;
    };
    return (await branch.readRawEvents(sessionId, signal)).events;
  }

  /**
   * rewind 前确保 agent 可驱动重放：live agent 先等待其停下（rewind 会截断其
   * session 内存 log，须在 quiescence 后执行）；cold 会话先 resume 出驻留
   * agent（此时会话完整，resume 的 prepare 不与截断冲突）。agents 服务缺失或
   * 无需重放时返回空——调用方退化为就地截断版本。
   */
  private async prepareReplay(
    sessionId: SessionId,
    queuedUsers: readonly UserMessage[],
    signal: AbortSignal | undefined,
    headerConfig?: { provider?: string; model?: string; maxTokens?: number },
  ): Promise<{ agent: EditorAgent | undefined }> {
    if (queuedUsers.length === 0) return { agent: undefined };
    signal?.throwIfAborted();
    const agents = this.ctx.get("agents") as EditorAgentRegistry | undefined;
    if (agents === undefined) return { agent: undefined };
    const existing = agents.get(sessionId);
    if (existing !== undefined) {
      await existing.whenIdle();
      signal?.throwIfAborted();
      // 清空 inbox 残留（rewind 将删除这些输入所属轮次的事件；残留消息若
      // 不清空，agent 后续 splice 落库后无法从日志重放——inbox 增量投影
      // 假设 log 只 append）。
      if (existing.inboxPending) existing.clearInbox();
      return { agent: existing };
    }
    // cold：resume 已持久化会话（create 会因「已存在持久化日志」失败）。
    // resume 失败是硬错误：rewind 尚未发生，编辑保持原子（不截断不丢数据）。
    const provider = headerConfig?.provider ?? "";
    const model = headerConfig?.model ?? "";
    if (provider.length === 0 || model.length === 0) {
      // 兜底：从当前会话 events 解析（headerConfig 未提供时）。
      const events = await this.readEvents(sessionId, signal);
      const config = events.findLast((event) => event.type === "request/header")?.data.header
        .config;
      const fallbackProvider = config?.provider ?? "";
      const fallbackModel = config?.model ?? "";
      if (fallbackProvider.length === 0 || fallbackModel.length === 0) {
        throw new SessionBranchError(
          "无法重放：会话没有可解析的模型配置。",
          "INVALID_BOUNDARY",
        );
      }
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: fallbackProvider, model: fallbackModel },
      });
      signal?.throwIfAborted();
      return { agent: handle.agent };
    }
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider, model },
    });
    signal?.throwIfAborted();
    return { agent: handle.agent };
  }
}

export default SessionEditor;

// ---------------------------------------------------------------------------
// HTTP 面（host）：GET /session-editor（timeline 投影）/ POST /session-editor
// （edit | reroll | retry | rewind | fork）。
// ---------------------------------------------------------------------------

interface HttpRequestLike {
  method?: string;
  url?: string;
  on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
}

interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): void;
}

interface HttpServerLike {
  register(route: {
    kind: "exact";
    path: string;
    handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>;
  }): () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: HttpServerLike;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("请求体必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function sessionIdOf(value: unknown): SessionId {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("sessionId 必须是非空字符串。");
  return value as SessionId;
}

function integerOf(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} 必须是非负安全整数。`);
  }
  return value as number;
}

function cascadeOf(value: unknown): import("@morlay/session-branch").CascadePolicy {
  if (value !== "truncate" && value !== "preserve")
    throw new TypeError("cascade 必须是 truncate 或 preserve。");
  return value;
}

function decodeOperation(value: unknown): SessionEditorOperation {
  const record = objectValue(value);
  const sessionId = sessionIdOf(record["sessionId"]);
  switch (record["action"]) {
    case "edit":
      if (typeof record["text"] !== "string") throw new TypeError("text 必须是字符串。");
      return {
        action: "edit",
        sessionId,
        eventSeq: integerOf(record["eventSeq"], "eventSeq"),
        blockIndex: integerOf(record["blockIndex"], "blockIndex"),
        text: record["text"],
        cascade: cascadeOf(record["cascade"]),
      };
    case "reroll":
      return { action: "reroll", sessionId };
    case "retry":
      return {
        action: "retry",
        sessionId,
        turn: integerOf(record["turn"], "turn"),
        cascade: cascadeOf(record["cascade"]),
      };
    case "rewind":
      return {
        action: "rewind",
        sessionId,
        toBoundary: integerOf(record["toBoundary"], "toBoundary"),
      };
    case "fork":
      return {
        action: "fork",
        sessionId,
        ...(record["atSeq"] === undefined ? {} : { atSeq: integerOf(record["atSeq"], "atSeq") }),
        ...(record["childSessionId"] === undefined
          ? {}
          : { childSessionId: sessionIdOf(record["childSessionId"]) }),
      };
    default:
      throw new TypeError("action 必须是 edit、reroll、retry、rewind 或 fork。");
  }
}

function requestJson(request: HttpRequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = "";
    request.on("data", (chunk) => {
      text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    });
    request.on("end", () => {
      try {
        text += decoder.decode();
        resolve(JSON.parse(text) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function respondJson(response: HttpResponseLike, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readTimeline(
  editor: SessionEditor,
  sessionId: SessionId,
): Promise<SessionEditorTimeline> {
  const timeline = await editor.timeline(sessionId);
  const messages = await editor.editableMessages(sessionId);
  const retryable = await editor.retryableTurns(sessionId);
  return toTimelinePayload(sessionId, timeline, messages, retryable);
}

async function runOperation(
  editor: SessionEditor,
  operation: SessionEditorOperation,
): Promise<SessionEditorOperationResult> {
  switch (operation.action) {
    case "edit": {
      const result = await editor.edit(operation);
      return {
        sessionId: result.sessionId,
        queuedTurns: result.queuedTurns,
        ...(result.live === undefined ? {} : { live: result.live }),
      };
    }
    case "reroll": {
      const result = await editor.reroll(operation);
      return {
        sessionId: result.sessionId,
        queuedTurns: result.queuedTurns,
        ...(result.live === undefined ? {} : { live: result.live }),
      };
    }
    case "retry": {
      const result = await editor.retry(operation);
      return {
        sessionId: result.sessionId,
        queuedTurns: result.queuedTurns,
        ...(result.live === undefined ? {} : { live: result.live }),
      };
    }
    case "rewind":
      await editor.rewind(operation.sessionId, operation.toBoundary);
      return { sessionId: operation.sessionId, queuedTurns: 0 };
    case "fork":
      return {
        sessionId: await editor.fork(
          operation.sessionId,
          operation.atSeq,
          operation.childSessionId,
        ),
        queuedTurns: 0,
      };
  }
}

async function handleRoute(
  editor: SessionEditor,
  request: HttpRequestLike,
  response: HttpResponseLike,
): Promise<void> {
  try {
    if (request.method === "GET") {
      const url = new URL(request.url ?? SESSION_EDITOR_PATH, "http://session-editor.local");
      const sessionId = sessionIdOf(url.searchParams.get("sessionId"));
      respondJson(response, 200, await readTimeline(editor, sessionId));
      return;
    }
    if (request.method === "POST") {
      respondJson(
        response,
        200,
        await runOperation(editor, decodeOperation(await requestJson(request))),
      );
      return;
    }
    response.writeHead(405);
    response.end();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(response, error instanceof TypeError ? 400 : 409, {
      error: message,
    });
  }
}

function registerHttpRoutes(ctx: Context): void {
  const webServer = ctx.get("webServer") as HttpServerLike | undefined;
  if (webServer === undefined) return;
  ctx.effect(() => {
    const editor = ctx.sessionEditor;
    return webServer.register({
      kind: "exact",
      path: SESSION_EDITOR_PATH,
      handler: (request, response) => handleRoute(editor, request, response),
    });
  }, "session-editor: HTTP route");
}
