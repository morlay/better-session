import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { toSqliteSchema } from "./adapters/index.ts";
import { sqliteTableDefs } from "./entities/index.ts";

export const SCHEMA_VERSION = 2;

export const SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 0x44534850;

export const EPHEMERAL_EVENT_TYPES = ["assistant/chunk"] as const;

export const EVENT_ENCODING = "json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqliteTables: Record<string, any> = toSqliteSchema(sqliteTableDefs);

export const tPersistenceState = sqliteTables["t_persistence_state"]!;

export const tSessions = sqliteTables["t_sessions"]!;

export const tEvents = sqliteTables["t_events"]!;

export const tSessionEvents = sqliteTables["t_session_events"]!;

export type { SessionRow } from "./backend.ts";

export type { EventRow } from "./backend.ts";

export type JournalMode = "wal" | "delete" | "truncate" | "persist";

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function isEphemeralType(type: string): boolean {
  return (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(type);
}

export function isPersistedEvent(event: SessionEvent): boolean {
  return (
    !isEphemeralType(event.type) &&
    (event as SessionEvent & { ignorable?: unknown }).ignorable !== true
  );
}

export type EventKind =
  | "message"
  | "thinking"
  | "turn"
  | "tool"
  | "request"
  | "config"
  | "audit"
  | "lifecycle"
  | "inbox"
  | "compaction"
  | "llm"
  | "subagent"
  | "team"
  | "workflow"
  | "goal"
  | "schedule"
  | "todo"
  | "web";

export type EventRole = "user" | "assistant" | "tool";

export function eventKind(event: { type: string; data?: unknown }): EventKind | "" {
  switch (event.type) {
    case "user/message":
      return "message";
    case "assistant/message": {
      const content = (event.data as { message?: { content?: unknown[] } }).message?.content;
      if (content?.some((block) => (block as { type?: string })?.type === "reasoning")) {
        return "thinking";
      }
      return "message";
    }
    case "turn/start":
    case "turn/end":
    case "step/start":
    case "step/end":
    case "session/end-seed":
      return "turn";
    case "tool/call":
    case "tool/result":
    case "tool/code-dispatch-start":
    case "tool/code-dispatch":
      return "tool";
    case "request/header":
    case "request/context":
      return "request";
    case "model/selection":
    case "permission/preset":
    case "approval/policy":
    case "sandbox/mode":
    case "plan/mode":
    case "agent-preset/selected":
      return "config";
    case "approval/asked":
    case "approval/decided":
    case "command/run":
    case "command/done":
    case "hook/invoked":
    case "hook/result":
    case "feedback/record":
      return "audit";
    case "session/title":
    case "session/title-llm-request":
    case "session-log-deepseek/delivery-accepted":
      return "lifecycle";
    case "agent/inbox/spliced":
      return "inbox";
    case "compaction/start":
    case "compaction/end":
    case "compaction/summary":
    case "compaction/prune":
      return "compaction";
    case "llm/retry":
    case "llm/retry-started":
      return "llm";
    case "subagent/descriptor":
    case "subagent/model-selection-policy":
      return "subagent";
    case "team/member":
    case "team/task":
    case "team/message/queued":
    case "team/message/delivered":
      return "team";
    case "tool-workflow/run-start":
    case "tool-workflow/run-end":
    case "tool-workflow/agent-start":
    case "tool-workflow/agent-end":
      return "workflow";
    case "goal/change":
      return "goal";
    case "schedule/change":
      return "schedule";
    case "todo/write":
      return "todo";
    case "web/deepseek-search-llm-request":
      return "web";
    default:
      return ""; // unknown plugin-merged type
  }
}

export function eventDimensions(event: SessionEvent): {
  kind: string;
  role: string;
  name: string;
  actionId: string;
} {
  const kind = eventKind(event);
  // 插件合并类型不在 core 的判别联合内，type/data 经结构化视图访问。
  const type = event.type as string;
  const data = event.data as Record<string, unknown>;
  switch (type) {
    case "user/message":
      return { kind, role: "user", name: "", actionId: "" };
    case "assistant/message":
      return { kind, role: "assistant", name: "", actionId: "" };
    case "tool/result": {
      // append 可能携带旧形状（无 message）；可选链容忍。
      const message = data["message"] as { content?: Array<{ toolCallId?: string }> } | undefined;
      return { kind, role: "tool", name: "", actionId: message?.content?.[0]?.toolCallId ?? "" };
    }
    case "tool/call":
      return {
        kind,
        role: "",
        name: typeof data["name"] === "string" ? data["name"] : "",
        actionId: typeof data["callId"] === "string" ? data["callId"] : "",
      };
    case "tool/code-dispatch-start":
    case "tool/code-dispatch":
      return {
        kind,
        role: "",
        name: "",
        actionId: typeof data["subCallId"] === "string" ? data["subCallId"] : "",
      };
    case "command/run":
    case "command/done":
      return {
        kind,
        role: "",
        name: type === "command/run" && typeof data["name"] === "string" ? data["name"] : "",
        actionId: typeof data["commandId"] === "string" ? data["commandId"] : "",
      };
    case "approval/asked":
    case "approval/decided":
      return {
        kind,
        role: "",
        name: "",
        actionId: typeof data["id"] === "string" ? data["id"] : "",
      };
    case "hook/invoked":
    case "hook/result":
      return {
        kind,
        role: "",
        name: "",
        actionId: typeof data["handlerId"] === "string" ? data["handlerId"] : "",
      };
    case "llm/retry":
    case "llm/retry-started":
      return {
        kind,
        role: "",
        name: "",
        actionId: typeof data["retryId"] === "string" ? data["retryId"] : "",
      };
    case "tool-workflow/run-start":
    case "tool-workflow/run-end":
    case "tool-workflow/agent-start":
    case "tool-workflow/agent-end":
      return {
        kind,
        role: "",
        name: "",
        actionId: typeof data["runId"] === "string" ? data["runId"] : "",
      };
    case "todo/write":
      return { kind, role: "", name: "todos", actionId: "" };
    case "subagent/descriptor":
      return {
        kind,
        role: "",
        name: typeof data["label"] === "string" ? data["label"] : "",
        actionId: "",
      };
    default:
      return { kind, role: "", name: "", actionId: "" };
  }
}
