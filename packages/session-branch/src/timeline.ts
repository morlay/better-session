/**
 * 版本树投影的共享组合逻辑：从持久化快照列表 + 每会话「自有后缀」读版本
 * 效果事件，导出完整 lineage 树。具体后端（`SessionBranch` 实现）提供数据
 * 读取，本模块做纯投影——根与后代的确定、自有版本效果的扫描、节点归一。
 *
 * 规则（对齐 `dsh-message-edit` 的数据模型）：
 * - `parentSession` 构成版本树；`seedLength` 区分继承与自有后缀。
 * - 每个会话至多一个**自有** `session-branch/version` 事件（seq ≥ seedLength）。
 * - 根节点（无 `parentSession`）不带版本效果。
 * - 版本效果 id 全局唯一；逆链（`inverse.sessionId`）必须指向树内父节点。
 *
 * @module @morlay/session-branch/timeline
 */

import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistenceSnapshot } from "@deepseek-ai/dsh-session-persistence";
import {
  SessionBranchError,
  isSessionBranchVersionEvent,
  type BranchTimeline,
  type BranchVersionNode,
  type SessionBranchVersionEventEnvelope,
} from "./types.ts";

/**
 * 读取一个会话「自有后缀」事件的函数——live 会话传 `events.slice(seedLength)`，
 * 持久化会话传 `sessionPersistence.readFrom(id, seedLength)`。
 */
export type OwnEventsReader = (
  id: SessionId,
  fromSeq: number,
  signal?: AbortSignal,
) => Promise<readonly import("@deepseek-ai/dsh-session").SessionEvent[]>;

/**
 * 从会话快照集合构建 `sessionId` 的完整版本树。
 * @param snapshots - 全部持久化会话的轻量快照（header + revision）。
 * @param readOwnEvents - 按会话读取自有后缀事件。
 * @param sessionId - 当前会话 id（树中标记为 current 由调用方负责）。
 * @param signal - 读取取消。
 */
export async function buildTimeline(
  snapshots: readonly SessionPersistenceSnapshot[],
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
      seedLength: header.seedLength ?? 0,
      createdAt: header.createdAt,
    };
    // 根节点不可能带版本效果；其余节点读自有后缀。
    if (header.parentSession !== undefined) {
      const events = await readOwnEvents(header.id, node.seedLength, signal);
      // 结构化守卫 + find（避免 filter 的 `S extends T` 约束——版本事件类型不在
      // SessionEvent 判别联合的固化 `SessionEventType` 中）。
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
