/**
 * 多 session 并发复现测试（临时）：验证多个 session 同时写入时是否损坏。
 * 全部走冷路径（dispose 后重新 mount load），真正验证 DB 中的稠密 log。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import type { Session } from "@deepseek-ai/dsh-session";
import { createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { EmptySettings } from "./testing/helpers.ts";
import SessionPersistenceRdb from "../index.ts";

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

/** 一个完整 turn（含 delta 流），返回后该 session 的 turn 是关闭的。 */
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
  s.append("assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "text-delta", index: 0, text: "x" },
  });
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
    // 两轮并发写（每个 session 两轮 turn），flush 交错进行。
    for (let round = 0; round < 2; round++) {
      for (const s of sessions) appendTurn(s, round);
      await Promise.all(sessions.map((s) => b.ctx.sessions.flush(s)));
    }
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const loaded = await b2.ctx.sessionPersistence.load(SessionId(`live-${i}`));
      const seqs = loaded.events.map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k));
      expect(seqs.length).toBe(12); // 每轮 6 个持久化事件 × 2
      expect(loaded.events.every((e) => e.type !== "assistant/chunk")).toBe(true);
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
    // 两个连接并发写两个不同 session。
    await Promise.all([b1.ctx.sessions.flush(s1), b2.ctx.sessions.flush(s2)]);
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    const l1 = await b3.ctx.sessionPersistence.load(SessionId("inst-1"));
    const l2 = await b3.ctx.sessionPersistence.load(SessionId("inst-2"));
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
    // 完全并发：不按轮次，直接一次性 append 全部再 flush。
    for (const s of sessions) appendTurn(s, 0);
    await Promise.all(sessions.map((s) => b.ctx.sessions.flush(s)));
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const loaded = await b2.ctx.sessionPersistence.load(SessionId(`p-${i}`));
      expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    }
    await b2.dispose();
  });

  it("append + load racing on one id stays consistent (cold path)", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const s = b.ctx.sessions.create(SessionId("race"));
    // 连续追加 turn 片段并频繁 load（live 路径不报错即可）。
    for (let k = 0; k < 4; k++) {
      appendTurn(s, k);
      await b.ctx.sessions.flush(s);
      await b.ctx.sessionPersistence.load(SessionId("race"));
    }
    await b.dispose();

    const b2 = await mount(path);
    const final = await b2.ctx.sessionPersistence.load(SessionId("race"));
    expect(final.events.map((e) => e.seq)).toEqual(
      Array.from({ length: final.events.length }, (_, k) => k),
    );
    await b2.dispose();
  });

  it("subagent-style: MANY parallel fork children (seeded, delta-heavy) persist dense-intact", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    // parent 先跑一个完整 turn（含 delta），作为 fork 的 seed 来源。
    const parent = b.ctx.sessions.create(SessionId("parent"));
    appendTurn(parent, 0);
    await b.ctx.sessions.flush(parent);

    // 并行 fork 8 个 child：每个 child 继承 parent 的完整前缀（上游 seq 含 delta）。
    const N = 8;
    const children = Array.from({ length: N }, (_, i) =>
      b.ctx.sessions.fork(parent, undefined, SessionId(`child-${i}`)),
    );
    // 并行 append：每个 child 再跑一轮含 delta 的 turn，不逐个 flush——模拟
    // subagent 并行唤起时多个 session 同时经事件驱动写路径持久化。
    for (const c of children) appendTurn(c, 0);
    await Promise.all(children.map((c) => b.ctx.sessions.flush(c)));
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const loaded = await b2.ctx.sessionPersistence.load(SessionId(`child-${i}`));
      const seqs = loaded.events.map((e) => e.seq);
      // child log = parent 前缀（delta 过滤后 6）+ session/end-seed（1）+
      // 自身 turn（delta 过滤后 6）= 13：稠密连续、无 chunk、无跨 session 拼接。
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k));
      expect(seqs.length).toBe(13);
      expect(loaded.events.every((e) => e.type !== "assistant/chunk")).toBe(true);
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
    // parent 与所有 child 同时并发写（交错事件循环）。
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
    const parentLoaded = await b2.ctx.sessionPersistence.load(SessionId("parent-2"));
    expect(parentLoaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (let i = 0; i < N; i++) {
      const loaded = await b2.ctx.sessionPersistence.load(SessionId(`sib-${i}`));
      expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }
    await b2.dispose();
  });
});
