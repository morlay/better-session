/**
 * `WriteGuard` 状态机直接单测：并发写者检测的时序契约（never-read /
 * confirmed-absence / confirmed head）与 delta 剔除的跨批累积，不再需要
 * 端到端双实例堆栈即可覆盖。
 */
import { describe, expect, it } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session";
import { WriteGuard } from "../write-guard.ts";

function expectRejected(fn: () => void, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected assertNoConcurrentWriter to reject");
}

describe("WriteGuard: concurrent-writer detection", () => {
  it("a never-read session with no stored row passes (fresh log)", () => {
    const guard = new WriteGuard();
    expect(() => guard.assertNoConcurrentWriter(SessionId("s1"), -1)).not.toThrow();
  });

  it("a never-read session WITH a stored row is rejected (must load first)", () => {
    const guard = new WriteGuard();
    expectRejected(
      () => guard.assertNoConcurrentWriter(SessionId("s1"), 0),
      /has a persisted log this instance has not read/,
    );
  });

  it("a confirmed absence rejects a row that appeared behind this instance's back", () => {
    const guard = new WriteGuard();
    guard.confirmHead(SessionId("s1"), -1);
    expectRejected(
      () => guard.assertNoConcurrentWriter(SessionId("s1"), 2),
      /modified by another writer/,
    );
  });

  it("a confirmed head matches the stored head (own writes / observed load)", () => {
    const guard = new WriteGuard();
    guard.confirmHead(SessionId("s1"), 5);
    expect(() => guard.assertNoConcurrentWriter(SessionId("s1"), 5)).not.toThrow();
  });

  it("a stored head advanced past the confirmed head is rejected (second writer committed)", () => {
    const guard = new WriteGuard();
    guard.confirmHead(SessionId("s1"), 2);
    expectRejected(
      () => guard.assertNoConcurrentWriter(SessionId("s1"), 5),
      /modified by another writer \(stored head 5, this instance last confirmed head 2\)/,
    );
  });

  it("a stored head behind the confirmed head is rejected too (rewind by another writer)", () => {
    const guard = new WriteGuard();
    guard.confirmHead(SessionId("s1"), 5);
    expectRejected(
      () => guard.assertNoConcurrentWriter(SessionId("s1"), 2),
      /modified by another writer/,
    );
  });

  it("confirm advances the accepted head (append after commit)", () => {
    const guard = new WriteGuard();
    guard.confirmHead(SessionId("s1"), 0);
    guard.confirmHead(SessionId("s1"), 3);
    expect(() => guard.assertNoConcurrentWriter(SessionId("s1"), 3)).not.toThrow();
  });

  it("sessions are independent: one session's writer does not affect another's", () => {
    const guard = new WriteGuard();
    guard.confirmHead(SessionId("s1"), 1);
    guard.confirmHead(SessionId("s2"), -1);
    expect(() => guard.assertNoConcurrentWriter(SessionId("s1"), 1)).not.toThrow();
    expect(() => guard.assertNoConcurrentWriter(SessionId("s2"), -1)).not.toThrow();
    expectRejected(
      () => guard.assertNoConcurrentWriter(SessionId("s2"), 0),
      /modified by another writer/,
    );
  });
});

describe("WriteGuard: dropped-delta provenance pruning", () => {
  it("no dropped seqs recorded → refs pass through untouched", () => {
    const guard = new WriteGuard();
    const refs = [1, 2, 3];
    expect(guard.pruneRefs(SessionId("s1"), refs)).toEqual([1, 2, 3]);
    // A fresh array is returned; the input is never mutated.
    expect(guard.pruneRefs(SessionId("s1"), refs)).not.toBe(refs);
  });

  it("prunes references that hit dropped delta seqs and keeps the rest", () => {
    const guard = new WriteGuard();
    guard.noteDropped(SessionId("s1"), [4, 7]);
    expect(guard.pruneRefs(SessionId("s1"), [2, 4, 5, 7])).toEqual([2, 5]);
  });

  it("dropped seqs accumulate across batches (later assistant/message prunes earlier deltas)", () => {
    const guard = new WriteGuard();
    guard.noteDropped(SessionId("s1"), [4]);
    guard.noteDropped(SessionId("s1"), [7, 9]);
    expect(guard.pruneRefs(SessionId("s1"), [4, 7, 9, 10])).toEqual([10]);
  });

  it("a fully pruned list becomes empty (the serializer stores null)", () => {
    const guard = new WriteGuard();
    guard.noteDropped(SessionId("s1"), [1, 2]);
    expect(guard.pruneRefs(SessionId("s1"), [1, 2])).toEqual([]);
  });

  it("sessions are independent: dropped seqs of one session do not prune another's refs", () => {
    const guard = new WriteGuard();
    guard.noteDropped(SessionId("s1"), [1]);
    expect(guard.pruneRefs(SessionId("s2"), [1])).toEqual([1]);
  });
});
