import { Service, type Context } from "@deepseek-ai/cordis";
import type { AssistantMessage, UserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type {
  AgentCancelCause,
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
  RecallOperation,
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
  droppedCompactions,
  editableMessages,
  editPlan,
  precedingContentIndex,
  recallBoundary,
  restoreCompactions,
  retryPlan,
  rerollPlan,
  retryableTurns,
} from "./plan.ts";

export type { CascadePolicy, EditableBlockKind } from "@morlay/session-branch";
export type {
  EditableMessageBlock,
  EditOperation,
  RecallOperation,
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

  whenIdle(): Promise<void>;

  cancel?(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void;
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
    seq: SessionSeq(events.length),
    time: Date.now(),
    data,
    surfaceOp: intent.surfaceOp,
    ...(intent.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: intent.sourceEventSeqs }),
  } as unknown as SessionEvent<T>);
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
    { turn, step: 1, message: assistant, stream: [] },
    {
      surfaceOp: "append",
    },
  );
  appendLogSeedEvent(events, "step/end", { turn, step: 1 });
  appendLogSeedEvent(events, "turn/end", {
    turn,
    reason: { kind: "completed" },
  });
}

// 边界事件的保留语义（与 session-branch 的 rewind 一致）：turn/end 保留边界事件本身，user/message 丢掉它自己。
function keepFromOf(events: readonly SessionEvent[], boundary: number): number {
  if (boundary < 0) return 0;
  return events[boundary]?.type === "turn/end" ? boundary + 1 : boundary;
}

async function appendSeedSuffixLive(
  session: Session,
  seedSuffix: readonly SessionEvent[],
  appendDirect: (events: readonly SessionEvent[]) => Promise<void>,
): Promise<void> {
  for (const event of seedSuffix) {
    const ignorable = (event as { ignorable?: boolean }).ignorable === true;
    if (ignorable) {
      const s = session as unknown as {
        log: SessionEvent[];
        eventsSnapshot?: unknown;
      };

      const seq = s.log.length;
      await appendDirect([{ ...event, seq } as SessionEvent]);
      s.log.push({ ...event, seq } as SessionEvent);
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

  async rewind(id: SessionId, toBoundary: number, signal?: AbortSignal) {
    await this.stopLoop(id, signal);
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

  recall(operation: RecallOperation, signal?: AbortSignal): Promise<SessionEditorResult> {
    return this.recallOperation(operation, signal);
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

    const headerConfig = events.findLast((event) => event.type === "request/header")?.data.header
      .config;

    const turnIndex = turns.findIndex((turn) => turn.startSeq === plan.anchorSeq);

    const preceding = precedingContentIndex(turns, turnIndex);
    const boundary =
      plan.rewindBoundary !== undefined
        ? plan.rewindBoundary
        : preceding < 0
          ? -1
          : turns[preceding]!.endSeq!;
    // 补回被截断丢掉、但在重放目标之前的压缩
    const keepFrom = keepFromOf(events, boundary);
    const compactions = droppedCompactions(events, keepFrom, plan.targetSeq);

    const replayTurn = preceding < 0 ? 1 : turns[preceding]!.turn + 1;

    const versionSeed: SessionEvent[] = [];
    appendLogSeedEvent(versionSeed, "session-branch/version", plan.version, true);
    const manualSeed: SessionEvent[] = [];
    if (plan.manualTurn !== undefined) {
      appendManualTurn(manualSeed, { ...plan.manualTurn, turn: replayTurn });
    }

    const replay = await this.prepareReplay(
      operation.sessionId,
      plan.queuedUsers,
      signal,
      headerConfig,
    );

    await this.stopLoop(operation.sessionId, signal);
    const live = this.ctx.sessions.get(operation.sessionId);
    await this.ctx.sessionBranch.rewind(operation.sessionId, boundary, signal);
    // 补回的压缩落在版本效果之后、重放的输入之前
    const seedStart = this.seedStart(live, events, keepFrom);
    const seedSuffix: SessionEvent[] = [
      ...versionSeed,
      ...restoreCompactions(compactions, keepFrom, seedStart + versionSeed.length),
      ...manualSeed,
    ];
    await this.appendSeedSuffix(operation.sessionId, live, seedSuffix, events, keepFrom);

    let queuedTurns = 0;
    if (replay.agent !== undefined && plan.queuedUsers.length > 0) {
      const lastSeedTurn = seedSuffix.findLast((event) => event.type === "turn/start")?.data.turn;
      if (lastSeedTurn !== undefined) {
        const phase = (replay.agent as unknown as { phase?: { lastTurn?: number } }).phase;
        if (phase !== undefined) phase.lastTurn = lastSeedTurn;
      }
      for (const message of plan.queuedUsers) replay.agent.followup(message);
      await this.ctx.sessions.flush(replay.agent.session);
      queuedTurns = plan.queuedUsers.length;
    }
    return {
      sessionId: operation.sessionId,
      queuedTurns,

      live: this.ctx.sessions.get(operation.sessionId) !== undefined,
    };
  }

  private async recallOperation(
    operation: RecallOperation,
    signal?: AbortSignal,
  ): Promise<SessionEditorResult> {
    signal?.throwIfAborted();
    const events = await this.readEvents(operation.sessionId, signal);
    const boundary = recallBoundary(events, closedTurns(events), operation.eventSeq);
    // 撤回同样要补回被丢掉、但在撤回目标之前的压缩
    const keepFrom = keepFromOf(events, boundary);
    const compactions = droppedCompactions(events, keepFrom, operation.eventSeq);

    await this.stopLoop(operation.sessionId, signal);
    const live = this.ctx.sessions.get(operation.sessionId);
    await this.ctx.sessionBranch.rewind(operation.sessionId, boundary, signal);
    await this.appendSeedSuffix(
      operation.sessionId,
      live,
      restoreCompactions(compactions, keepFrom, this.seedStart(live, events, keepFrom)),
      events,
      keepFrom,
    );
    return {
      sessionId: operation.sessionId,
      queuedTurns: 0,
      live: this.ctx.sessions.get(operation.sessionId) !== undefined,
    };
  }

  // 种子后缀的起点 seq：live 会话是被截断后的日志长度，cold 会话是配平后的保留前缀长度
  private seedStart(
    live: Session | undefined,
    events: readonly SessionEvent[],
    keepFrom: number,
  ): number {
    return live === undefined
      ? balanceRewindPrefix(events.slice(0, keepFrom)).length
      : Number(live.seq);
  }

  private async appendSeedSuffix(
    sessionId: SessionId,
    live: Session | undefined,
    seedSuffix: readonly SessionEvent[],
    events: readonly SessionEvent[],
    keepFrom: number,
  ): Promise<void> {
    if (seedSuffix.length === 0) return;
    if (live !== undefined) {
      const persistence = this.ctx.sessionPersistence as unknown as {
        tracker: {
          writerOf(id: SessionId):
            | {
                append(events: readonly SessionEvent[]): Promise<void>;
              }
            | undefined;
        };
      };
      const handle = persistence.tracker.writerOf(sessionId);
      if (handle === undefined) {
        throw new Error(`session "${sessionId}" has no live write handle for the version effect`);
      }

      await this.ctx.sessions.flush(live);
      await appendSeedSuffixLive(live, seedSuffix, (batch) => handle.append(batch));
      await this.ctx.sessions.flush(live);
      return;
    }

    const keepLength = balanceRewindPrefix(events.slice(0, keepFrom)).length;
    const renumbered = seedSuffix.map(
      (event, index) =>
        ({
          ...event,
          seq: keepLength + index,
        }) as SessionEvent,
    );
    const handle = await this.ctx.sessionPersistence.open(sessionId, "write");
    try {
      await handle.append(renumbered);
    } finally {
      await handle.close();
    }
  }

  private async stopLoop(sessionId: SessionId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const agents = this.ctx.get("agents") as EditorAgentRegistry | undefined;
    const existing = agents?.get(sessionId);
    if (existing === undefined) return;
    existing.cancel?.({ kind: "user" }, { keepInbox: true });
    await existing.whenIdle();
    signal?.throwIfAborted();
  }

  private async readEvents(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<readonly SessionEvent[]> {
    const live = this.ctx.sessions.get(sessionId);
    if (live !== undefined) return live.snapshotEvents();

    const branch = this.ctx.sessionBranch as unknown as {
      readRawEvents(
        id: SessionId,
        signal?: AbortSignal,
      ): Promise<{ meta: unknown; events: readonly SessionEvent[] }>;
    };
    return (await branch.readRawEvents(sessionId, signal)).events;
  }

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
      return { agent: existing };
    }

    const provider = headerConfig?.provider ?? "";
    const model = headerConfig?.model ?? "";
    if (provider.length === 0 || model.length === 0) {
      const events = await this.readEvents(sessionId, signal);
      const config = events.findLast((event) => event.type === "request/header")?.data.header
        .config;
      const fallbackProvider = config?.provider ?? "";
      const fallbackModel = config?.model ?? "";
      if (fallbackProvider.length === 0 || fallbackModel.length === 0) {
        throw new SessionBranchError("无法重放：会话没有可解析的模型配置。", "INVALID_BOUNDARY");
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
    case "recall":
      return {
        action: "recall",
        sessionId,
        eventSeq: integerOf(record["eventSeq"], "eventSeq"),
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
      throw new TypeError("action 必须是 edit、reroll、retry、rewind、recall 或 fork。");
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
    case "recall": {
      const result = await editor.recall(operation);
      return {
        sessionId: result.sessionId,
        queuedTurns: result.queuedTurns,
        ...(result.live === undefined ? {} : { live: result.live }),
      };
    }
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
  ctx.effect(() => {
    // webServer 的类型由上游 @deepseek-ai/dsh-host-webserver 声明（`Context.webServer: WebServer`）；
    // 这里只按用到的 register 面做结构转换，不再 declare module 覆盖，否则两处声明冲突（TS2717）。
    const webServer = ctx.get("webServer") as unknown as HttpServerLike | undefined;
    if (webServer === undefined) return () => {};
    const editor = ctx.sessionEditor;
    return webServer.register({
      kind: "exact",
      path: SESSION_EDITOR_PATH,
      handler: (request, response) => handleRoute(editor, request, response),
    });
  }, "session-editor: HTTP route");

  const registerConnectionRoute = (): void => {
    const connection = ctx.get("connection", false) as
      | {
          fetch: {
            register(route: {
              path: string;
              methods: readonly ("GET" | "HEAD" | "POST")[];
              requestBody: "buffered" | "streaming";
              fetch: (request: Request) => Promise<Response>;
            }): () => Promise<void>;
          };
        }
      | undefined;
    if (connection === undefined) return;
    const editor = ctx.sessionEditor;
    ctx.effect(
      () =>
        connection.fetch.register({
          path: `/api${SESSION_EDITOR_PATH}`,
          methods: ["GET", "POST"],
          requestBody: "buffered",
          fetch: (request) => handleFetchRoute(editor, request),
        }),
      "session-editor: connection fetch route",
    );
  };
  ctx.on("internal/service", (name) => {
    if (name === "connection") registerConnectionRoute();
  });
  registerConnectionRoute();
}

async function handleFetchRoute(editor: SessionEditor, request: Request): Promise<Response> {
  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const sessionId = sessionIdOf(url.searchParams.get("sessionId"));
      return jsonResponse(200, await readTimeline(editor, sessionId));
    }
    if (request.method === "POST") {
      return jsonResponse(200, await runOperation(editor, decodeOperation(await request.json())));
    }
    return new Response(null, { status: 405 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse(error instanceof TypeError ? 400 : 409, { error: message });
  }
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
