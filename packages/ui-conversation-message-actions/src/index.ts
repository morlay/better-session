/**
 * 编排层 `SessionEditor`：在 `@morlay/session-branch` 的 provider 抽象之上
 * 组装 rewind / retry / fork 的**完整功能**（参考 `dsh-message-edit` 的
 * 产品语义：edit / reroll / retry + 级联策略 + 版本树）。
 *
 * 分层边界：
 * - 数据层（forkFrom / rewind / readBranchPrefix）由 `ctx.sessionBranch`
 *   （provider 实现，如 `@morlay/session-rdb`）提供；
 * - 本服务只做**编排**：闭合轮次扫描、版本效果事件构造、派生 seed 组装、
 *   rewind 命令透传、版本树投影；
 * - agent 驱动（重放用户输入 / 创建子 agent）是**可选增强**：`agents`
 *   服务以 duck-typed 接口使用（不硬依赖 `@deepseek-ai/dsh-agent`），
 *   缺失时退化为「创建持久化版本」——版本已 durable，之后可随时 resume。
 *
 * @module @morlay/ui-conversation-message-actions
 */

import { Service, type Context } from "@deepseek-ai/cordis";
import type { AssistantMessage, ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm";
import type {
  Session,
  SessionEvent,
  SessionId,
  SurfaceEventType,
  SurfaceIntent,
} from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import {
  SESSION_BRANCH_VERSION_SCHEMA,
  SessionBranchError,
  balanceRewindPrefix,
  type BranchBoundary,
  type BranchTimeline,
  type EditableBlockKind,
  type SessionBranchEffect,
  type SessionBranchVersionEvent,
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

/** 闭合轮次折叠（纯函数，供编辑面枚举与测试）。 */
export { closedTurns, editableMessages, retryableTurns };
export { SESSION_BRANCH_VERSION_SCHEMA } from "@morlay/session-branch";

/** 版本树投影别名（透传 `@morlay/session-branch`）。 */
export type { BranchTimeline, SessionBranchVersionEvent } from "@morlay/session-branch";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionEditor: SessionEditor;
  }
}

/** —— agent 驱动的 duck-typed 接口（不硬依赖 @deepseek-ai/dsh-agent） —— */

export interface EditorAgent {
  readonly session: Session;
  followup(message: UserMessage): void;
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
  /** 从已持久化会话恢复 agent（`AgentRegistry.resume`；create 对已持久化会话失败）。 */
  resume(options: {
    resumeSessionId: SessionId;
    agentOptions?: { provider: string; model: string; maxTokens?: number };
  }): Promise<EditorAgentHandle>;
}

/** —— 闭合轮次扫描（纯函数） —— */

interface ClosedTurn {
  turn: number;
  startSeq: number;
  /** 闭合轮次的 `turn/end` seq；未闭合轮次为 undefined。 */
  endSeq?: number;
  /** 是否已闭合（有 `turn/end`）。未闭合轮次的 user 消息仍可编辑。 */
  closed: boolean;
  user?: SessionEvent<"user/message">;
  assistants: SessionEvent<"assistant/message">[];
}

function closedTurns(events: readonly SessionEvent[]): ClosedTurn[] {
  const result: ClosedTurn[] = [];
  let current: Omit<ClosedTurn, "endSeq" | "closed"> | undefined;
  for (const event of events) {
    if (event.type === "turn/start") {
      current = { turn: event.data.turn, startSeq: event.seq, assistants: [] };
      continue;
    }
    if (current === undefined) continue;
    if (
      event.type === "user/message" &&
      current.user === undefined &&
      event.data.source.kind === "user"
    ) {
      current.user = event;
      continue;
    }
    if (event.type === "assistant/message" && event.data.turn === current.turn) {
      current.assistants.push(event);
      continue;
    }
    if (event.type === "turn/end" && event.data.turn === current.turn) {
      result.push({ ...current, endSeq: event.seq, closed: true });
      current = undefined;
    }
  }
  // 未闭合轮次（log 尾部没有 turn/end）也保留：其 user 消息已 append 落定，
  // 编辑时 rewind 到该消息（exclusive drop）重放即可。
  if (current !== undefined) result.push({ ...current, closed: false });
  return result;
}

function isTextualBlock(
  block: ContentBlock | undefined,
): block is Extract<ContentBlock, { type: "text" | "reasoning" }> {
  return block?.type === "text" || block?.type === "reasoning";
}

function userText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function cloneUser(
  message: UserMessage,
  content: ContentBlock[] = structuredClone(message.content),
): UserMessage {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze(content),
    source: Object.freeze({ kind: "user" }),
  }) as UserMessage;
}

function replaceTextBlock(
  content: readonly ContentBlock[],
  blockIndex: number,
  text: string,
): ContentBlock[] {
  const block = content[blockIndex];
  if (!isTextualBlock(block))
    throw new SessionBranchError("所选内容块不是可编辑文本。", "INVALID_BOUNDARY");
  return content.map((candidate, index) =>
    index === blockIndex ? ({ ...candidate, text } as ContentBlock) : structuredClone(candidate),
  );
}

function editableMessages(turns: readonly ClosedTurn[]): EditableMessageBlock[] {
  const result: EditableMessageBlock[] = [];
  for (const turn of turns) {
    if (turn.user !== undefined) {
      for (const [blockIndex, block] of turn.user.data.content.entries()) {
        if (block.type !== "text") continue;
        result.push({
          key: `${String(turn.user.seq)}:${String(blockIndex)}`,
          turn: turn.turn,
          eventSeq: turn.user.seq,
          blockIndex,
          kind: "user",
          text: block.text,
          time: turn.user.time,
        });
      }
    }
    // 未闭合轮次的助手消息是流式 partial，不可编辑（服务端拒绝）。
    if (!turn.closed) continue;
    for (const event of turn.assistants) {
      for (const [blockIndex, block] of event.data.message.content.entries()) {
        if (!isTextualBlock(block)) continue;
        result.push({
          key: `${String(event.seq)}:${String(blockIndex)}`,
          turn: turn.turn,
          eventSeq: event.seq,
          blockIndex,
          kind: block.type === "reasoning" ? "assistant.reasoning" : "assistant.response",
          text: block.text,
          time: event.time,
        });
      }
    }
  }
  return result;
}

function retryableTurns(turns: readonly ClosedTurn[]): RetryableTurn[] {
  return turns.flatMap((turn): RetryableTurn[] =>
    // 未闭合轮次不可重试（无已落定回复可重生成；UI 的 retry 按钮也要求
    // turn 已闭合）。
    turn.user === undefined || !turn.closed
      ? []
      : [
          {
            turn: turn.turn,
            userEventSeq: turn.user.seq,
            preview: userText(turn.user.data),
            time: turn.user.time,
          },
        ],
  );
}

function downstreamUsers(turns: readonly ClosedTurn[], start: number): UserMessage[] {
  return turns
    .slice(start)
    .flatMap((turn): UserMessage[] => (turn.user === undefined ? [] : [cloneUser(turn.user.data)]));
}

function assistantReplacement(
  event: SessionEvent<"assistant/message">,
  blockIndex: number,
  text: string,
): AssistantMessage {
  const replaced = replaceTextBlock(event.data.message.content, blockIndex, text).filter(
    (block) => block.type === "text" || block.type === "reasoning",
  );
  return Object.freeze({
    id: randomUUID(),
    role: "assistant",
    content: Object.freeze(replaced),
    source: Object.freeze({
      kind: "model",
      provider: event.data.message.source.provider,
      model: event.data.message.source.model,
    }),
  }) as AssistantMessage;
}

/** —— 版本效果与派生计划 —— */

interface OperationPlan {
  /** 目标轮 startSeq（`before` 锚定用；派生点 = 该轮之前最后一个 turn/end）。 */
  anchorSeq: number;
  /**
   * 未闭合轮次 user 编辑：rewind 边界 = 该 user 消息 seq（exclusive——drop
   * 该消息及其后，由编辑版重放替换）。闭合轮次编辑不设置（boundary 走
   * 前一轮 turn/end 的 inclusive 语义）。
   */
  rewindBoundary?: number;
  version: SessionBranchVersionEvent;
  /** 助手块编辑：以编辑后内容构造的完整手工闭合回合。 */
  manualTurn?: { turn: number; user: UserMessage; assistant: AssistantMessage };
  /** 排队重放的用户输入（truncate = 目标轮输入；preserve = 目标轮起全部）。 */
  queuedUsers: UserMessage[];
}

function pairVersionEffect(
  sourceSessionId: SessionId,
  effect: Omit<SessionBranchEffect, "id">,
): SessionBranchVersionEvent {
  return {
    schemaVersion: SESSION_BRANCH_VERSION_SCHEMA,
    effect: { ...effect, id: randomUUID() },
    inverse: { kind: "restore-version", sessionId: sourceSessionId },
  };
}

function editPlan(operation: EditOperation, turns: readonly ClosedTurn[]): OperationPlan {
  const turnIndex = turns.findIndex(
    (turn) =>
      operation.eventSeq > turn.startSeq &&
      (turn.endSeq === undefined || operation.eventSeq < turn.endSeq),
  );
  const turn = turns[turnIndex];
  if (turn === undefined)
    throw new SessionBranchError("所选消息不属于已落定回合。", "INVALID_BOUNDARY");
  const event =
    turn.user?.seq === operation.eventSeq
      ? turn.user
      : turn.assistants.find((candidate) => candidate.seq === operation.eventSeq);
  if (event === undefined)
    throw new SessionBranchError("所选消息不存在或不可编辑。", "INVALID_BOUNDARY");

  if (event.type === "user/message") {
    const before = event.data.content[operation.blockIndex];
    if (before?.type !== "text")
      throw new SessionBranchError("所选用户消息块不是文本。", "INVALID_BOUNDARY");
    const edited = cloneUser(
      event.data,
      replaceTextBlock(event.data.content, operation.blockIndex, operation.text),
    );
    const later = operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : [];
    return {
      anchorSeq: turn.startSeq,
      // 未闭合轮次：rewind 到该 user 消息（exclusive drop 该消息及其后），
      // 由编辑版重放替换；闭合轮次走前一轮 turn/end 的 inclusive 语义。
      ...(turn.closed ? {} : { rewindBoundary: event.seq }),
      version: pairVersionEffect(operation.sessionId, {
        operation: "edit",
        cascade: operation.cascade,
        targetTurn: turn.turn,
        targetEventSeq: event.seq,
        targetBlockIndex: operation.blockIndex,
        blockKind: "user",
        before: before.text,
        after: operation.text,
      }),
      queuedUsers: [edited, ...later],
    };
  }

  // 未闭合轮次的助手消息是流式 partial，没有最终内容可编辑。
  if (!turn.closed)
    throw new SessionBranchError("未闭合轮次的助手消息不可编辑。", "INVALID_BOUNDARY");
  const before = event.data.message.content[operation.blockIndex];
  if (!isTextualBlock(before))
    throw new SessionBranchError("所选助手消息块不是文本或思考。", "INVALID_BOUNDARY");
  const blockKind: EditableBlockKind =
    before.type === "reasoning" ? "assistant.reasoning" : "assistant.response";
  if (turn.user === undefined)
    throw new SessionBranchError("所选助手消息没有可重建的用户输入。", "INVALID_BOUNDARY");
  return {
    anchorSeq: turn.startSeq,
    version: pairVersionEffect(operation.sessionId, {
      operation: "edit",
      cascade: operation.cascade,
      targetTurn: turn.turn,
      targetEventSeq: event.seq,
      targetBlockIndex: operation.blockIndex,
      blockKind,
      before: before.text,
      after: operation.text,
    }),
    manualTurn: {
      turn: turn.turn,
      user: cloneUser(turn.user.data),
      assistant: assistantReplacement(event, operation.blockIndex, operation.text),
    },
    queuedUsers: operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : [],
  };
}

function retryPlan(operation: RetryOperation, turns: readonly ClosedTurn[]): OperationPlan {
  const turnIndex = turns.findIndex((turn) => turn.turn === operation.turn);
  const turn = turns[turnIndex];
  if (turn?.user === undefined)
    throw new SessionBranchError("所选回合没有可重放的用户输入。", "INVALID_BOUNDARY");
  return {
    anchorSeq: turn.startSeq,
    version: pairVersionEffect(operation.sessionId, {
      operation: "retry",
      cascade: operation.cascade,
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
    }),
    queuedUsers:
      operation.cascade === "preserve"
        ? downstreamUsers(turns, turnIndex)
        : [cloneUser(turn.user.data)],
  };
}

function rerollPlan(operation: RerollOperation, turns: readonly ClosedTurn[]): OperationPlan {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    // 未闭合轮次没有已落定的助手回复可重生成。
    if (turn?.user === undefined || !turn.closed) continue;
    const target = turn.assistants.findLast((event) =>
      event.data.message.content.some(isTextualBlock),
    );
    if (target === undefined) continue;
    return {
      anchorSeq: turn.startSeq,
      version: pairVersionEffect(operation.sessionId, {
        operation: "reroll",
        cascade: "truncate",
        targetTurn: turn.turn,
        targetEventSeq: target.seq,
      }),
      queuedUsers: [cloneUser(turn.user.data)],
    };
  }
  throw new SessionBranchError("当前会话没有可重生成的已落定助手回复。", "INVALID_BOUNDARY");
}

/** —— 种子事件构造（本地纯事件构造器；Session 构造时统一验证） —— */

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
  appendLogSeedEvent(events, "turn/end", { turn, reason: { kind: "completed" } });
}

/**
 * 把派生 seed 后缀落地到 **live** 会话。上游 `Session.append` 不保留
 * `ignorable` 标记（只保留 type/data/surface 元数据），而版本效果事件必须
 * 保持 ignorable（live log 保留、不落 canonical log），因此：
 * - ignorable 事件（版本效果）直接 push 内存 log（不发布 `session/event`；
 *   服务端语义事件，客户端无需感知；surfaceManager 对非 surface 事件 fold
 *   无副作用）；
 * - 其余事件（手工回合 manualTurn）走 `append`（surface 校验 + 发布）。
 * 后续统一由 write-behind flush 落盘（RDB 稠密化时过滤 ignorable）。
 */
function appendSeedSuffixLive(session: Session, seedSuffix: readonly SessionEvent[]): void {
  for (const event of seedSuffix) {
    if (event.ignorable === true) {
      const s = session as unknown as {
        log: SessionEvent[];
        eventsSnapshot?: unknown;
      };
      // 版本效果：ignorable 语义（live log 保留、不落 canonical log）。
      // session.append 不保留 ignorable 标记，因此直接 push 内存 log（不发布
      // session/event；服务端语义事件，客户端无需感知；surfaceManager 对非
      // surface 事件 fold 无副作用）。seq 按 log 续接重编号（seedSuffix 内部
      // 编号从 0 起，与截断后 live log 不对齐）。
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

/** —— 编排服务 —— */

/**
 * `ctx.sessionEditor`：rewind / retry / fork 的完整功能编排。
 * 组合 `ctx.sessionBranch`（provider 抽象）与可选的 `agents` 服务。
 */
export class SessionEditor extends Service {
  static inject = ["sessionBranch", "sessionPersistence", "sessions"];

  constructor(ctx: Context) {
    super(ctx, "sessionEditor");
    // HTTP 路由随类构造注册（dsh 用 default 类插件，apply 函数不被调用）。
    // bundles 顺序保证 webserver（ctx.n）先于本类实例化。
    registerHttpRoutes(ctx);
  }

  /** 定位 `atSeq` 锚定的闭合边界（透传 provider）。 */
  readBranchPrefix(
    id: SessionId,
    atSeq?: number,
    mode?: "after" | "before",
    signal?: AbortSignal,
  ): Promise<BranchBoundary> {
    return this.ctx.sessionBranch.readBranchPrefix(id, atSeq, mode, signal);
  }

  /** 从持久化源派生新会话（透传 provider；不驱动 agent）。 */
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

  /** 截断式回退：原会话回退到闭合边界（透传 provider）。 */
  rewind(id: SessionId, toBoundary: number, signal?: AbortSignal) {
    return this.ctx.sessionBranch.rewind(id, toBoundary, signal);
  }

  /**
   * 清洗一个会话的 surface/provenance 坐标为稠密空间（透传 sessionBranch）。
   * 历史加载失败（坐标混叠导致 seed 校验失败）时调用,清洗后重新加载即可。
   * `cleanseSession` 是 rdb 实现层新增的服务面（契约层 `SessionBranch`
   * 没有此方法）,经运行时访问。
   */
  cleanseSession(sessionId: SessionId, signal?: AbortSignal): Promise<{ changed: number }> {
    const branch = this.ctx.sessionBranch as unknown as {
      cleanseSession(id: SessionId, signal?: AbortSignal): Promise<{ changed: number }>;
    };
    return branch.cleanseSession(sessionId, signal);
  }

  /** 完整版本树投影（透传 provider 组合）。 */
  timeline(sessionId: SessionId, signal?: AbortSignal): Promise<BranchTimeline> {
    return this.ctx.sessionBranch.timeline(sessionId, signal);
  }

  /** 编辑一个已落定文本块并从其轮次边界分支。 */
  edit(operation: EditOperation, signal?: AbortSignal): Promise<SessionEditorResult> {
    return this.branchOperation(operation, signal);
  }

  /** 重生成最后一条已落定助手回复。 */
  reroll(operation: RerollOperation, signal?: AbortSignal): Promise<SessionEditorResult> {
    return this.branchOperation(operation, signal);
  }

  /** 重试任意历史回合。 */
  retry(operation: RetryOperation, signal?: AbortSignal): Promise<SessionEditorResult> {
    return this.branchOperation(operation, signal);
  }

  /** 可编辑消息块枚举（Timeline 编辑面）。 */
  async editableMessages(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<EditableMessageBlock[]> {
    const events = await this.readEvents(sessionId, signal);
    return editableMessages(closedTurns(events));
  }

  /** 可重试回合枚举（Timeline 重试面）。 */
  async retryableTurns(sessionId: SessionId, signal?: AbortSignal): Promise<RetryableTurn[]> {
    const events = await this.readEvents(sessionId, signal);
    return retryableTurns(closedTurns(events));
  }

  /** 执行一个分支式操作（edit / reroll / retry）。 */
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
    // rewind 前解析模型配置：就地编辑可能截断掉最后的 request/header
    // （编辑第一轮 boundary = -1 会清空全部），重放 agent 需要 provider/model。
    const headerConfig = events.findLast((event) => event.type === "request/header")?.data.header
      .config;

    // 派生 seed 后缀：版本效果 + 可选手工回合。版本事件对核心是 ignorable
    // （上游不认识；branch 层后端特判保留），保证非 branch 读者可安全跳过。
    const seedSuffix: SessionEvent[] = [];
    appendLogSeedEvent(seedSuffix, "session-branch/version", plan.version, true);
    if (plan.manualTurn !== undefined) appendManualTurn(seedSuffix, plan.manualTurn);

    // 就地编辑：不创建新会话、不改变 session id。先 rewind 截断原会话到
    // 目标轮之前的闭合边界（抛弃后续事件），再把版本效果与重放输入
    // append 回同一会话，最后（可选）驱动 agent 重放排队输入。
    // 未闭合轮次 user 编辑：rewind 边界 = 该 user 消息 seq（exclusive drop
    // 该消息及其后，由编辑版重放替换）；闭合轮次编辑走前一轮 turn/end 的
    // inclusive 语义。
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
        // live：落地内存 log（版本效果 ignorable 保留、manualTurn 走 append），
        // 同步 coordinator cursor 后显式 flush（版本效果 push 不发布、不进
        // 缓冲，cursor 会落后 log——不 sync 则 manualTurn 的 seq 校验错位）。
        appendSeedSuffixLive(live, seedSuffix);
        this.ctx.sessionBranch.syncLiveCursor(operation.sessionId);
        await this.ctx.sessions.flush(live);
      } else {
        // rewind 后保留的事件数：turn/end inclusive = boundary + 1；
        // user/message exclusive = boundary（该消息被 drop，由编辑版替换）。
        // 与 rdb rewind 一致地平衡化：exclusive 截断可能残留未配对的
        // step/start（真实 agent-loop 的 step/start 在 user/message 之前），
        // 续写 seq 必须从平衡后的保留前缀续接，否则落盘 log 对 token meter
        // 重放非法（孤儿 step/start 使后续 step/start 报错）。
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

    // 可选增强：agent 驱动（重放排队用户输入）。缺失 agents 服务时退化为
    // 已 durable 的就地版本——可随时继续输入。
    const queuedTurns = await this.driveAgent(
      operation.sessionId,
      plan.queuedUsers,
      signal,
      headerConfig,
    );
    return {
      sessionId: operation.sessionId,
      queuedTurns,
      // live 标记：操作后是否仍有 live owner（driveAgent 可能 resume 出 agent）。
      live: this.ctx.sessions.get(operation.sessionId) !== undefined,
    };
  }

  /** 读取会话事件：live 优先，否则走持久化原始读取（不含合成 closers）。 */
  private async readEvents(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<readonly SessionEvent[]> {
    const live = this.ctx.sessions.get(sessionId);
    if (live !== undefined) return live.events;
    // cold：读原始事件（`loadStored`，scanRows 只做 torn-tail 切割、不补
    // closers）。`inspect` 会经 coordinator 的 `prepareCore` 给未闭合 log
    // 补合成 step/end + turn/end——未闭合轮次被掩盖成闭合，编辑未闭合轮次
    // 的 user 消息会走错边界。
    const branch = this.ctx.sessionBranch as unknown as {
      readRawEvents(
        id: SessionId,
        signal?: AbortSignal,
      ): Promise<{ meta: unknown; events: readonly SessionEvent[] }>;
    };
    return (await branch.readRawEvents(sessionId, signal)).events;
  }

  /**
   * 可选 agent 驱动：优先复用现有 live agent（用户会话驻留——rewind 已截断
   * 其 session 内存，followup 会基于截断后历史重放），否则 `resume` 已持久化
   * 会话。模型配置来自 branchOperation 在 rewind 前解析的 `headerConfig`
   * （rewind 可能截断 request/header）；缺失时回退到当前 events。无 agents
   * 服务、无可用模型路由或恢复失败时退化为持久化版本（已 durable）。
   * 返回实际排队的输入数。
   */
  private async driveAgent(
    sessionId: SessionId,
    queuedUsers: readonly UserMessage[],
    signal?: AbortSignal,
    headerConfig?: { provider?: string; model?: string; maxTokens?: number },
  ): Promise<number> {
    if (queuedUsers.length === 0) return 0;
    signal?.throwIfAborted();
    const agents = this.ctx.get("agents") as EditorAgentRegistry | undefined;
    if (agents === undefined) return 0;
    const provider = headerConfig?.provider ?? "";
    const model = headerConfig?.model ?? "";
    if (provider.length === 0 || model.length === 0) {
      // 兜底：从当前会话 events 解析（headerConfig 未由调用方提供时）。
      const events = await this.readEvents(sessionId, signal);
      const config = events.findLast((event) => event.type === "request/header")?.data.header
        .config;
      const fallbackProvider = config?.provider ?? "";
      const fallbackModel = config?.model ?? "";
      if (fallbackProvider.length === 0 || fallbackModel.length === 0) return 0;
      return this.queueThroughAgent(
        sessionId,
        queuedUsers,
        signal,
        fallbackProvider,
        fallbackModel,
      );
    }
    return this.queueThroughAgent(sessionId, queuedUsers, signal, provider, model);
  }

  /** 经 live agent（复用）或 resume（重建）排队重放输入；返回排队数。 */
  private async queueThroughAgent(
    sessionId: SessionId,
    queuedUsers: readonly UserMessage[],
    signal: AbortSignal | undefined,
    provider: string,
    model: string,
  ): Promise<number> {
    const agents = this.ctx.get("agents") as EditorAgentRegistry | undefined;
    if (agents === undefined) return 0;
    // 现有 live agent（用户会话驻留）：直接排队输入——就地编辑后其 session
    // 内存已被 rewind 截断，followup 基于截断后历史重放，不改 id、不重建。
    const existing = agents.get(sessionId);
    if (existing !== undefined) {
      for (const message of queuedUsers) existing.followup(message);
      await this.ctx.sessions.flush(existing.session);
      return queuedUsers.length;
    }
    // cold：resume 已持久化会话（create 会因「已存在持久化日志」失败）。
    // resume 后 agent 驻留（与用户发消息后的正常状态一致），不 dispose——
    // dispose 会把 session 从 store 移除，破坏客户端打开的窗口。
    const handle = await agents
      .resume({ resumeSessionId: sessionId, agentOptions: { provider, model } })
      .catch((error: unknown) => {
        // agent 组合失败不应使已 durable 的版本失效：退化为持久化版本。
        this.ctx.logger.warn(
          "session-editor: agent resume failed (%s); version remains durable",
          String(error),
        );
        return undefined;
      });
    if (handle === undefined) return 0;
    for (const message of queuedUsers) handle.agent.followup(message);
    await this.ctx.sessions.flush(handle.agent.session);
    return queuedUsers.length;
  }
}

export default SessionEditor;

// ---------------------------------------------------------------------------
// HTTP 面（host）：GET /session-editor（timeline 投影）/ POST /session-editor
// （edit | reroll | retry | rewind | fork）。参考 dsh-message-edit 的同源端点。
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
    /** dsh web 的 HTTP route carrier（@deepseek-ai/dsh-host-webserver，`WebRoute` 协议）。 */
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
    case "cleanse":
      return { action: "cleanse", sessionId };
    default:
      throw new TypeError("action 必须是 edit、reroll、retry、rewind、fork 或 cleanse。");
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

/** GET 投影：timeline + 编辑/重试面。 */
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
    case "cleanse": {
      const { changed } = await editor.cleanseSession(operation.sessionId);
      return { sessionId: operation.sessionId, queuedTurns: 0, changed };
    }
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
    respondJson(response, error instanceof TypeError ? 400 : 409, { error: message });
  }
}

/** 注册同源 HTTP 路由（`ctx.webServer` 由 dsh web 的 webserver 包提供；缺失时跳过）。 */
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
