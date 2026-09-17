import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import type { Session } from "@deepseek-ai/dsh-session";
import { createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
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
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-multi-"));
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

function appendTurn(s: Session, round: number): void {
  void round;
  s.append("turn/start", { turn: 1 });
  s.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  s.append("step/start", { turn: 1, step: 1 });
  s.append(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      message: createMessage({
        role: "assistant",
        content: [],
        source: { kind: "model", provider: "mock", model: "mock" },
      }),
      stream: [],
    },
    { surfaceOp: "append" },
  );
  s.append("step/end", { turn: 1, step: 1 });
  s.append("turn/end", { turn: 1, reason: { kind: "completed" } });
}

describe("multi-session repro (cold-path verification)", () => {
  it("many live sessions append concurrently, then each reloads dense-intact", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const N = 12;
    const sessions: Session[] = [];
    for (let i = 0; i < N; i++) sessions.push(b.ctx.sessions.create(SessionId(`live-${i}`)));

    for (let round = 0; round < 2; round++) {
      for (const s of sessions) appendTurn(s, round);
      await Promise.all(sessions.map((s) => b.ctx.sessions.flush(s)));
    }
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const loaded = await rdb(b2.ctx).load(SessionId(`live-${i}`));
      const seqs = loaded.events.map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k));
      expect(seqs.length).toBe(12);
    }
    await b2.dispose();
  });

  it("two backend instances share one file and append different sessions concurrently", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const s1 = b1.ctx.sessions.create(SessionId("inst-1"));
    const s2 = b2.ctx.sessions.create(SessionId("inst-2"));
    appendTurn(s1, 0);
    appendTurn(s2, 0);

    await Promise.all([b1.ctx.sessions.flush(s1), b2.ctx.sessions.flush(s2)]);
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    const l1 = await rdb(b3.ctx).load(SessionId("inst-1"));
    const l2 = await rdb(b3.ctx).load(SessionId("inst-2"));
    expect(l1.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(l2.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b3.dispose();
  });

  it("concurrent appends to MANY sessions on ONE live store never interleave parent chains", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const N = 20;
    const sessions: Session[] = [];
    for (let i = 0; i < N; i++) sessions.push(b.ctx.sessions.create(SessionId(`p-${i}`)));

    for (const s of sessions) appendTurn(s, 0);
    await Promise.all(sessions.map((s) => b.ctx.sessions.flush(s)));
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const loaded = await rdb(b2.ctx).load(SessionId(`p-${i}`));
      expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    }
    await b2.dispose();
  });

  it("append + load racing on one id stays consistent (cold path)", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const s = b.ctx.sessions.create(SessionId("race"));

    for (let k = 0; k < 4; k++) {
      appendTurn(s, k);
      await b.ctx.sessions.flush(s);
      await rdb(b.ctx).load(SessionId("race"));
    }
    await b.dispose();

    const b2 = await mount(path);
    const final = await rdb(b2.ctx).load(SessionId("race"));
    expect(final.events.map((e) => e.seq)).toEqual(
      Array.from({ length: final.events.length }, (_, k) => k),
    );
    await b2.dispose();
  });

  it("subagent-style: MANY parallel fork children (seeded, delta-heavy) persist dense-intact", async () => {
    const path = await freshDbPath();
    const b = await mount(path);

    const parent = b.ctx.sessions.create(SessionId("parent"));
    appendTurn(parent, 0);
    await b.ctx.sessions.flush(parent);

    const N = 8;
    const children = Array.from({ length: N }, (_, i) =>
      b.ctx.sessions.fork(parent, undefined, SessionId(`child-${i}`)),
    );

    for (const c of children) appendTurn(c, 0);
    await Promise.all(children.map((c) => b.ctx.sessions.flush(c)));
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const loaded = await rdb(b2.ctx).load(SessionId(`child-${i}`));
      const seqs = loaded.events.map((e) => e.seq);

      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k));
      expect(seqs.length).toBe(13);
    }
    await b2.dispose();
  });

  it("subagent-style: parallel children + parent all append interleaved, then all reload intact", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const parent = b.ctx.sessions.create(SessionId("parent-2"));
    const N = 6;
    const children = Array.from({ length: N }, (_, i) =>
      b.ctx.sessions.create(SessionId(`sib-${i}`)),
    );

    appendTurn(parent, 0);
    for (const c of children) appendTurn(c, 0);
    await Promise.all([
      b.ctx.sessions.flush(parent),
      ...children.map((c) => b.ctx.sessions.flush(c)),
    ]);
    appendTurn(parent, 1);
    for (const c of children) appendTurn(c, 1);
    await Promise.all([
      b.ctx.sessions.flush(parent),
      ...children.map((c) => b.ctx.sessions.flush(c)),
    ]);
    await b.dispose();

    const b2 = await mount(path);
    const parentLoaded = await rdb(b2.ctx).load(SessionId("parent-2"));
    expect(parentLoaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (let i = 0; i < N; i++) {
      const loaded = await rdb(b2.ctx).load(SessionId(`sib-${i}`));
      expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }
    await b2.dispose();
  });
});
