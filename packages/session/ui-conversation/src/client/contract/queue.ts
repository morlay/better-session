import type { SessionFace, SessionSnapshot } from "@deepseek-ai/dsh-api-session-controller/client";

export type QueueItemId = Parameters<SessionFace["updateQueue"]>[0];

export type QueueAction = Parameters<SessionFace["updateQueue"]>[1];

export type QueueRow = SessionSnapshot["queue"][number];
