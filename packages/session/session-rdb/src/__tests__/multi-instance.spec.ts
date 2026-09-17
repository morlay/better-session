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

    const c1 = await rdb(b1.ctx).create(header(id, "/a"));
    const c2 = await rdb(b2.ctx).create(header(id, "/b"));

    await c1.append(oneTurn(0));
    await c1.close();
    await c2.close();

    await expect(rdb(b2.ctx).append(id, oneTurn(0))).rejects.toThrow(
      /not found|seq mismatch|another writer|not read/i,
    );
    await Promise.all([b1.dispose(), b2.dispose()]);

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

    await createAndAppend(b1.ctx, header(id), oneTurn(0));

    await expect(rdb(b2.ctx).append(id, oneTurn(0))).rejects.toThrow(
      /another writer|not read|seq mismatch/i,
    );

    await rdb(b1.ctx).append(id, oneTurn(3));

    await expect(rdb(b2.ctx).append(id, oneTurn(0))).rejects.toThrow(
      /another writer|not read|seq mismatch/i,
    );
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    const loaded = await rdb(b3.ctx).load(id);

    expect(loaded.events).toHaveLength(6);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b3.dispose();
  });

  it("an instance that LOADED the session may append (authorized continuation); the stale writer is rejected", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    await createAndAppend(b1.ctx, header(SessionId("auth")), oneTurn(0));

    const b2 = await mount(path);
    const loaded = await rdb(b2.ctx).load(SessionId("auth"));
    expect(loaded.events).toHaveLength(3);
    await rdb(b2.ctx).append(SessionId("auth"), oneTurn(3));
    await b2.dispose();

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
