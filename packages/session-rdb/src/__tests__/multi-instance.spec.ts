/**
 * 多实例复现测试（临时）：两个 persistence 实例（两个 cordis Context / 两个
 * coordinator）共享同一 SQLite 文件时，同一个 session id 的并发写是否损坏。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { EmptySettings } from "./testing/helpers.ts";
import SessionPersistenceRdb from "../index.ts";

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
      seq: offset + 0,
      time: 1,
      data: { turn: 1 },
    },
    {
      type: "user/message",
      seq: offset + 1,
      time: 2,
      data: createUserMessage({
        content: [{ type: "text", text: `msg${offset}` }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    {
      type: "turn/end",
      seq: offset + 2,
      time: 3,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

describe("multi-instance repro", () => {
  it("two instances create the SAME id concurrently, then both append — log must not interleave", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const id = SessionId("shared-id");
    // 同时 create 同 id：两个 coordinator 都不知道对方（DB 都还没有行）。
    const c1 = b1.ctx.sessionPersistence.create({ id, version: 0, createdAt: 1, cwd: "/a" });
    const c2 = b2.ctx.sessionPersistence.create({ id, version: 0, createdAt: 1, cwd: "/b" });
    await Promise.all([c1, c2]);

    // 两个实例并发 append 各自的一轮 turn（各自 coordinator 的 cursor 都是 0）。
    // 第二个写入者必须被 FAIL LOUD 拒绝——绝不允许静默续接 b1 的 log 造成拼接。
    await b1.ctx.sessionPersistence.append(id, oneTurn(0));
    await expect(b2.ctx.sessionPersistence.append(id, oneTurn(0))).rejects.toThrow(
      /another writer|not read/i,
    );
    await Promise.all([b1.dispose(), b2.dispose()]);

    // 冷 load：只有第一写入者的一轮 turn（3 个事件，seq 0..2）——log 未被损坏。
    const b3 = await mount(path);
    const loaded = await b3.ctx.sessionPersistence.load(id);
    expect(loaded.events).toHaveLength(3);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    await b3.dispose();
  });

  it("two instances append DIFFERENT ids concurrently — no cross contamination", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const a1 = b1.ctx.sessionPersistence.create({ id: SessionId("i1"), version: 0, createdAt: 1 });
    const a2 = b2.ctx.sessionPersistence.create({ id: SessionId("i2"), version: 0, createdAt: 1 });
    await Promise.all([a1, a2]);
    await Promise.all([
      b1.ctx.sessionPersistence.append(SessionId("i1"), oneTurn(0)),
      b2.ctx.sessionPersistence.append(SessionId("i2"), oneTurn(0)),
    ]);
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    expect(
      (await b3.ctx.sessionPersistence.load(SessionId("i1"))).events.map((e) => e.seq),
    ).toEqual([0, 1, 2]);
    expect(
      (await b3.ctx.sessionPersistence.load(SessionId("i2"))).events.map((e) => e.seq),
    ).toEqual([0, 1, 2]);
    await b3.dispose();
  });

  it("SAME id, two instances, interleaved multi-batch appends stay consistent", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const id = SessionId("interleaved");
    await Promise.all([
      b1.ctx.sessionPersistence.create({ id, version: 0, createdAt: 1 }),
      b2.ctx.sessionPersistence.create({ id, version: 0, createdAt: 1 }),
    ]);
    // 两实例轮流交错写：b1 写第一轮，b2 必须被拒绝（它从未读过这个 log，
    // 却要写一个已有行的 session）；随后 b1 的下一轮正常续写。
    await b1.ctx.sessionPersistence.append(id, oneTurn(0));
    await expect(b2.ctx.sessionPersistence.append(id, oneTurn(0))).rejects.toThrow(
      /another writer|not read/i,
    );
    await b1.ctx.sessionPersistence.append(id, oneTurn(3));
    // b2 的 cursor 仍停在 0（第一次 append 被拒，coordinator 未推进），后续
    // append 同样被拒——无论消息来自 coordinator 的 seq 校验还是 backend 的
    // 竞争检测，都绝不允许 b2 静默续接 b1 的 log。
    await expect(b2.ctx.sessionPersistence.append(id, oneTurn(0))).rejects.toThrow(
      /seq mismatch|another writer|not read/i,
    );
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    const loaded = await b3.ctx.sessionPersistence.load(id);
    // 只有 b1 的两轮 turn（6 个事件，seq 0..5）——没有任何拼接损坏。
    expect(loaded.events).toHaveLength(6);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b3.dispose();
  });

  it("an instance that LOADED the session may append (authorized continuation); the stale writer is rejected", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    await b1.ctx.sessionPersistence.create({ id: SessionId("auth"), version: 0, createdAt: 1 });
    await b1.ctx.sessionPersistence.append(SessionId("auth"), oneTurn(0)); // b1: head 0..2

    // b2 明确 load 该 session（授权续接）：b2 的记录 head = 2 == 磁盘 head。
    const b2 = await mount(path);
    const loaded = await b2.ctx.sessionPersistence.load(SessionId("auth"));
    expect(loaded.events).toHaveLength(3);
    await b2.ctx.sessionPersistence.append(SessionId("auth"), oneTurn(3)); // 续接 3..5
    await b2.dispose();

    // b1 的 cursor 已过期（它不知道 b2 写过）：继续 append 必须被拒，绝不续接。
    await expect(b1.ctx.sessionPersistence.append(SessionId("auth"), oneTurn(3))).rejects.toThrow(
      /modified by another writer/,
    );
    await b1.dispose();

    const b3 = await mount(path);
    const final = await b3.ctx.sessionPersistence.load(SessionId("auth"));
    expect(final.events).toHaveLength(6);
    expect(final.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b3.dispose();
  });
});
