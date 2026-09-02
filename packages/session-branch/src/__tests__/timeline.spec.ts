/**
 * 版本树投影（buildTimeline）的纯逻辑测试：树构造、自有版本效果扫描、
 * 逆链校验与错误路径。不依赖真实持久化后端。
 */

import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import { SessionPersistenceRevision } from "@deepseek-ai/dsh-session-persistence";
import {
  SessionBranchError,
  SESSION_BRANCH_VERSION_SCHEMA,
  buildTimeline,
  type SessionBranchVersionEvent,
} from "../index.ts";

function header(id: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 0,
    id: id as SessionId,
    createdAt: 0,
    isSeeded: false,
    ...overrides,
  };
}

function snapshot(
  id: string,
  overrides: Partial<SessionHeader> = {},
  inheritedEventCount = 0,
): import("../timeline.ts").BranchSnapshot {
  const h = header(id, overrides);
  return {
    header: h,
    revision: SessionPersistenceRevision(`test:${id}:r0`),
    inheritedEventCount,
  };
}

function versionEvent(seq: number, event: SessionBranchVersionEvent): SessionEvent {
  return { type: "session-branch/version", seq, time: 0, data: event } as SessionEvent;
}

function pair(id: string, parent: string): SessionBranchVersionEvent {
  return {
    schemaVersion: SESSION_BRANCH_VERSION_SCHEMA,
    effect: {
      id: `effect-${id}`,
      operation: "retry",
      cascade: "truncate",
      targetTurn: 0,
      targetEventSeq: 0,
    },
    inverse: { kind: "restore-version", sessionId: parent as SessionId },
  };
}

const noOwnEvents = async (): Promise<SessionEvent[]> => [];

describe("buildTimeline", () => {
  it("returns a single root node for a root session", async () => {
    const timeline = await buildTimeline([snapshot("a")], noOwnEvents, "a" as SessionId);
    expect(timeline.root.sessionId).toBe("a");
    expect(timeline.nodes).toHaveLength(1);
    expect(timeline.nodes[0]?.effect).toBeUndefined();
  });

  it("folds own version effects from the non-inherited suffix", async () => {
    const snapshots = [
      snapshot("a"),
      snapshot("b", { parentSession: "a" as SessionId, isSeeded: true }, 3),
    ];
    const own = async (id: SessionId, fromSeq: number): Promise<SessionEvent[]> =>
      id === "b" && fromSeq === 3 ? [versionEvent(3, pair("b", "a"))] : [];
    const timeline = await buildTimeline(snapshots, own, "b" as SessionId);
    expect(timeline.nodes.map((node) => node.sessionId)).toEqual(["a", "b"]);
    const child = timeline.nodes[1];
    expect(child?.effect?.id).toBe("effect-b");
    expect(child?.inverseSessionId).toBe("a");
  });

  it("rejects a version whose inverse does not name its parent", async () => {
    const snapshots = [
      snapshot("a"),
      snapshot("b", { parentSession: "a" as SessionId, isSeeded: true }, 0),
    ];
    const broken = {
      schemaVersion: SESSION_BRANCH_VERSION_SCHEMA,
      effect: { id: "e", operation: "fork", cascade: "truncate", targetTurn: 0, targetEventSeq: 0 },
      inverse: { kind: "restore-version", sessionId: "zzz" as SessionId },
    } satisfies SessionBranchVersionEvent;
    const own = async (): Promise<SessionEvent[]> => [versionEvent(0, broken)];
    await expect(buildTimeline(snapshots, own, "b" as SessionId)).rejects.toThrow(
      SessionBranchError,
    );
  });

  it("rejects a session carrying multiple own version effects", async () => {
    const snapshots = [
      snapshot("a"),
      snapshot("b", { parentSession: "a" as SessionId, isSeeded: true }, 0),
    ];
    const own = async (): Promise<SessionEvent[]> => [
      versionEvent(0, pair("b1", "a")),
      versionEvent(1, pair("b2", "a")),
    ];
    await expect(buildTimeline(snapshots, own, "b" as SessionId)).rejects.toThrow(
      /multiple own version effects/,
    );
  });

  it("rejects a lineage cycle", async () => {
    const snapshots = [
      snapshot("a", { parentSession: "b" as SessionId }),
      snapshot("b", { parentSession: "a" as SessionId }),
    ];
    await expect(buildTimeline(snapshots, noOwnEvents, "a" as SessionId)).rejects.toThrow(/cycle/);
  });

  it("rejects an unknown session", async () => {
    await expect(buildTimeline([], noOwnEvents, "missing" as SessionId)).rejects.toThrow(
      SessionBranchError,
    );
  });
});
