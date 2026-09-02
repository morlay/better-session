import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import {
  SessionBranchError,
  isSessionBranchVersionEvent,
  type BranchTimeline,
  type BranchVersionNode,
  type SessionBranchVersionEventEnvelope,
} from "./types.ts";

export type BranchSnapshot = SessionPersistenceSnapshot & {
  inheritedEventCount: number;
};

export type OwnEventsReader = (
  id: SessionId,
  fromSeq: number,
  signal?: AbortSignal,
) => Promise<readonly import("@deepseek-ai/dsh-session").SessionEvent[]>;

export async function buildTimeline(
  snapshots: readonly BranchSnapshot[],
  readOwnEvents: OwnEventsReader,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<BranchTimeline> {
  const byId = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot] as const));

  // 回溯到根（当前会话 → 祖先链）。
  const ancestors: SessionId[] = [];
  let cursor: SessionId | undefined = sessionId;
  const seen = new Set<SessionId>();
  while (cursor !== undefined) {
    if (seen.has(cursor))
      throw new SessionBranchError("lineage contains a cycle", "INVALID_BOUNDARY");
    seen.add(cursor);
    ancestors.push(cursor);
    const snapshot = byId.get(cursor);
    cursor = snapshot?.header.parentSession;
  }
  const rootId = ancestors.at(-1);
  if (rootId === undefined) {
    throw new SessionBranchError(`session "${sessionId}" is not persisted`, "SESSION_NOT_FOUND");
  }

  // 根向下的完整后代（BFS；按 createdAt 稳定排序）。
  const ordered: SessionId[] = [];
  const queue: SessionId[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    ordered.push(id);
    const children = snapshots
      .filter((snapshot) => snapshot.header.parentSession === id)
      .sort(
        (left, right) =>
          left.header.createdAt - right.header.createdAt ||
          String(left.header.id).localeCompare(String(right.header.id)),
      )
      .map((snapshot) => snapshot.header.id);
    queue.push(...children);
  }

  const nodes: BranchVersionNode[] = [];
  const effectIds = new Set<string>();
  for (const id of ordered) {
    const snapshot = byId.get(id);
    if (snapshot === undefined) continue;
    const header = snapshot.header;
    const node: BranchVersionNode = {
      sessionId: header.id,
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
      seedLength: snapshot.inheritedEventCount ?? 0,
      createdAt: header.createdAt,
    };
    // 根节点不可能带版本效果；其余节点读自有后缀。
    if (header.parentSession !== undefined) {
      const events = await readOwnEvents(header.id, node.seedLength, signal);
      // 结构化守卫 + find（版本事件类型不在固化的 SessionEventType 中）。
      let version: SessionBranchVersionEventEnvelope | undefined;
      for (const event of events) {
        if (isSessionBranchVersionEvent(event)) {
          if (version !== undefined) {
            throw new SessionBranchError(
              `session ${header.id} carries multiple own version effects`,
              "INVALID_BOUNDARY",
            );
          }
          version = event;
        }
      }
      if (version !== undefined) {
        const data = version.data;
        if (
          data.inverse.kind !== "restore-version" ||
          data.inverse.sessionId !== header.parentSession
        ) {
          throw new SessionBranchError(
            `session ${header.id} version inverse does not match its parent`,
            "INVALID_BOUNDARY",
          );
        }
        if (effectIds.has(data.effect.id)) {
          throw new SessionBranchError(
            `version effect ${data.effect.id} is duplicated`,
            "INVALID_BOUNDARY",
          );
        }
        effectIds.add(data.effect.id);
        node.effect = data.effect;
        node.inverseSessionId = data.inverse.sessionId;
      }
    }
    nodes.push(node);
  }

  const root = nodes.find((node) => node.parentSessionId === undefined);
  if (root === undefined) {
    throw new SessionBranchError(`session "${sessionId}" lineage has no root`, "SESSION_NOT_FOUND");
  }
  return { root, nodes };
}
