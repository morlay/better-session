import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionStore,
  SessionId,
  SessionSeq,
  SESSION_FORMAT_VERSION,
} from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { EmptySettings } from "@morlay/session-rdb/testing";
import SessionPersistenceRdb from "@morlay/session-rdb";

/** 类型收窄：ctx.sessionPersistence 到 RDB 子类（便捷方法面）。 */
function rdb(ctx: import("@deepseek-ai/cordis").Context): SessionPersistenceRdb {
  return ctx.sessionPersistence as SessionPersistenceRdb;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 3 });
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-multiinst-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

async function mount(path: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
  return { ctx, dispose: () => fiber.dispose() };
}

function oneTurn(offset: number): SessionEvent[] {
  return [
    {
      type: "turn/start",
      seq: SessionSeq(offset + 0),
      time: 1,
      data: { turn: 1 },
    },
    {
      type: "user/message",
      seq: SessionSeq(offset + 1),
      time: 2,
      data: createUserMessage({
        content: [{ type: "text", text: `msg${offset}` }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    {
      type: "turn/end",
      seq: SessionSeq(offset + 2),
      time: 3,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

function header(id: SessionId, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** create + append + close（释放所有权，模拟「写入后离开」的实例）。 */
async function createAndAppend(
  ctx: Context,
  h: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const handle = await ctx.sessionPersistence.create(h);
  try {
    await handle.append(events);
  } finally {
    await handle.close();
  }
}

describe("multi-instance repro", () => {
  it("two instances create the SAME id concurrently, then both append — log must not interleave", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const id = SessionId("shared-id");
    // 同时 create 同 id：两个实例都不知道对方（DB 都还没有行）。
    const c1 = await rdb(b1.ctx).create(header(id, "/a"));
    const c2 = await rdb(b2.ctx).create(header(id, "/b"));
    // b1 写入并释放所有权；b2 的 pending 未 append 直接 close 被擦除。
    await c1.append(oneTurn(0));
    await c1.close();
    await c2.close();

    // b2 从未读过这个 log 却要 append：open(write) 找不到行（pending 已擦除）
    // 或 WriteGuard 拒绝——必须 FAIL LOUD，绝不允许静默续接 b1 的 log。
    await expect(rdb(b2.ctx).append(id, oneTurn(0))).rejects.toThrow(
      /not found|seq mismatch|another writer|not read/i,
    );
    await Promise.all([b1.dispose(), b2.dispose()]);

    // 冷 load：只有第一写入者的一轮 turn（3 个事件，seq 0..2）——log 未被损坏。
    const b3 = await mount(path);
    const loaded = await rdb(b3.ctx).load(id);
    expect(loaded.events).toHaveLength(3);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    await b3.dispose();
  });

  it("two instances append DIFFERENT ids concurrently — no cross contamination", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    await createAndAppend(b1.ctx, header(SessionId("i1")), oneTurn(0));
    await createAndAppend(b2.ctx, header(SessionId("i2")), oneTurn(0));
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    expect((await rdb(b3.ctx).load(SessionId("i1"))).events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await rdb(b3.ctx).load(SessionId("i2"))).events.map((e) => e.seq)).toEqual([0, 1, 2]);
    await b3.dispose();
  });

  it("SAME id, two instances, interleaved multi-batch appends stay consistent", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const id = SessionId("interleaved");
    // b1 落库一轮；b2 从未读过该 log。
    await createAndAppend(b1.ctx, header(id), oneTurn(0));
    // b2 直接 append：open(write) 找到行但本实例未确认 head → WriteGuard 拒绝。
    await expect(rdb(b2.ctx).append(id, oneTurn(0))).rejects.toThrow(
      /another writer|not read|seq mismatch/i,
    );
    // b1 的下一轮正常续写。
    await rdb(b1.ctx).append(id, oneTurn(3));
    // b2 再次 append 同样被拒——绝不允许 b2 静默续接 b1 的 log。
    await expect(rdb(b2.ctx).append(id, oneTurn(0))).rejects.toThrow(
      /another writer|not read|seq mismatch/i,
    );
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    const loaded = await rdb(b3.ctx).load(id);
    // 只有 b1 的两轮 turn（6 个事件，seq 0..5）——没有任何拼接损坏。
    expect(loaded.events).toHaveLength(6);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b3.dispose();
  });

  it("an instance that LOADED the session may append (authorized continuation); the stale writer is rejected", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    await createAndAppend(b1.ctx, header(SessionId("auth")), oneTurn(0)); // b1: head 0..2

    // b2 明确 load 该 session（授权续接）：open(write) 确认 head = 2 == 磁盘 head。
    const b2 = await mount(path);
    const loaded = await rdb(b2.ctx).load(SessionId("auth"));
    expect(loaded.events).toHaveLength(3);
    await rdb(b2.ctx).append(SessionId("auth"), oneTurn(3)); // 续接 3..5
    await b2.dispose();

    // b1 的确认 head 已过期（它不知道 b2 写过）：继续 append 必须被拒，绝不续接。
    // （append 便捷方法内部 open(write) 会重新确认 head，拒绝来自 seq mismatch。）
    await expect(rdb(b1.ctx).append(SessionId("auth"), oneTurn(3))).rejects.toThrow(
      /modified by another writer|seq mismatch/,
    );
    await b1.dispose();

    const b3 = await mount(path);
    const final = await rdb(b3.ctx).load(SessionId("auth"));
    expect(final.events).toHaveLength(6);
    expect(final.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b3.dispose();
  });
});
