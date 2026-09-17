import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SessionStore,
  SESSION_FORMAT_VERSION,
  Session,
} from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { TokenMeter, type TokenMeasurement } from "@deepseek-ai/dsh-token-meter";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { strToU8, zip } from "fflate";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { toJsonlArtifact } from "@morlay/session-rdb/artifact";
import { EmptySettings } from "@morlay/session-rdb/testing";
import { meta, oneTurnLog } from "@morlay/session-rdb/testing";
import {
  SESSION_IMPORT_PATH,
  SESSION_LOG_ARTIFACT_FILENAME,
  parseImportZip,
  parseJsonlArtifact,
  persistImport,
  registerSessionImport,
} from "@morlay/session-rdb/artifact";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "session-rdb-import-"));
  dirs.push(dir);
  return join(dir, "sessions.sqlite");
}

function fakeJsonRequest(body: unknown): import("node:http").IncomingMessage {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield chunk;
    },
  } as unknown as import("node:http").IncomingMessage;
}

function fakeResponse(): { res: import("node:http").ServerResponse; code: number; body: string } {
  const state = {
    res: undefined as unknown as import("node:http").ServerResponse,
    code: 0,
    body: "",
  };
  state.res = {
    writeHead: (code: number) => {
      state.code = code;
      return state.res;
    },
    end: (chunk?: string) => {
      if (chunk !== undefined) state.body = chunk;
    },
  } as unknown as import("node:http").ServerResponse;
  return state;
}

function richLog(): SessionEvent[] {
  return [
    { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: SessionSeq(1),
      time: 2,
      data: freezeMessage({
        id: MessageId("u1"),
        role: "user",
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    { type: "step/start", seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
    {
      type: "assistant/message",
      seq: SessionSeq(3),
      time: 4,
      data: {
        turn: 1,
        step: 1,
        message: freezeMessage({
          id: MessageId("a1"),
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "model", provider: "mock", model: "mock" },
        }),
        stream: [],
      },
      surfaceOp: "append",
    } as unknown as SessionEvent,
    { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: SessionSeq(5),
      time: 6,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

// oneTurnLog() 的轮次重编号：turnFrom(6, 2) 是 turn 2 的六个事件（seq 6..11）
function turnFrom(base: number, turnNumber: number): SessionEvent[] {
  return oneTurnLog().map((event, index) => {
    const data = event.data as { turn?: number };
    return {
      ...event,
      seq: SessionSeq(base + index),
      time: base + index + 1,
      data: data.turn === undefined ? event.data : { ...data, turn: turnNumber },
    } as SessionEvent;
  });
}

// 上游 TokenMeter 是 ctx 单例服务（同一 ctx 只能注册一个），比较「全新实例」的折叠结果时
// 在独立 ctx 上折叠同一个会话对象（measure 只读会话日志与可选的 llm 服务）。
function freshMeasurement(session: Session): TokenMeasurement {
  const probe = new Context();
  new SessionProjectionRegistry(probe);
  return new TokenMeter(probe).measure(session);
}

// fflate 的 `zip` 是回调式异步 API（node 侧内部走 worker_threads），测试夹具同样桥成 Promise；
// 它与 `zipSync` 产出字节一致，夹具本身不关心同步性。
function zipAsync(data: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(data, (error, output) => {
      if (error === null) resolve(output);
      else reject(error);
    });
  });
}

describe("parseJsonlArtifact", () => {
  it("parses a header line and plain event lines", () => {
    const parsed = parseJsonlArtifact(
      [
        JSON.stringify({
          type: "session",
          version: 0,
          id: "src",
          createdAt: 1000,
          cwd: "/work",
          delegationDepth: 0,
        }),
        JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }),
        JSON.stringify({
          type: "turn/end",
          seq: 1,
          time: 2,
          data: { turn: 1, reason: { kind: "completed" } },
        }),
      ].join("\n"),
    );
    expect(parsed.meta).toMatchObject({ id: "src", cwd: "/work", isSeeded: false });
    expect(parsed.inheritedEventCount).toBe(SessionLogOffset(0));
    expect(parsed.events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("converts a v0 artifact with legacy message shapes through the migration chain", () => {
    const parsed = parseJsonlArtifact(
      [
        JSON.stringify({
          type: "session",
          version: 0,
          id: "v0-import",
          createdAt: 1000,
          cwd: "/work",
          delegationDepth: 0,
        }),
        JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }),
        JSON.stringify({ type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } }),
        JSON.stringify({
          type: "user/message",
          seq: 2,
          time: 3,
          data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
          surfaceOp: "append",
        }),
        JSON.stringify({
          type: "assistant/message",
          seq: 3,
          time: 4,
          data: {
            turn: 1,
            step: 1,
            content: [{ type: "text", text: "hello" }],
            provenance: { provider: "mock", model: "mock" },
          },
          surfaceOp: "append",
        }),
        JSON.stringify({ type: "step/end", seq: 4, time: 5, data: { turn: 1, step: 1 } }),
        JSON.stringify({
          type: "turn/end",
          seq: 5,
          time: 6,
          data: { turn: 1, reason: { kind: "completed" } },
        }),
      ].join("\n"),
    );
    expect(parsed.meta).toMatchObject({
      id: "v0-import",
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
    });
    expect(parsed.events).toHaveLength(7);
    expect(parsed.events[2]?.type).toBe("system/message");
    const user = parsed.events[3]!;
    expect(user.type).toBe("user/message");
    expect(
      user.type === "user/message" && typeof user.data.id === "string" && user.data.id.length > 0,
    ).toBe(true);
    const assistant = parsed.events[4]!;
    expect(assistant.type).toBe("assistant/message");
    expect(
      assistant.type === "assistant/message" &&
        Array.isArray(assistant.data.stream) &&
        assistant.data.message.source.kind === "model",
    ).toBe(true);
  });

  it("carries seedLength as isSeeded + inheritedEventCount", () => {
    const parsed = parseJsonlArtifact(
      [
        JSON.stringify({
          type: "session",
          version: 0,
          id: "child",
          createdAt: 1000,
          parentSession: "parent",
          seedLength: 2,
          delegationDepth: 1,
        }),
        JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }),
        JSON.stringify({ type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } }),
      ].join("\n"),
    );
    expect(parsed.meta).toMatchObject({
      id: "child",
      parentSession: "parent",
      isSeeded: true,
      delegationDepth: 1,
    });

    expect(parsed.inheritedEventCount).toBe(SessionLogOffset(3));
  });

  it("rejects an empty log, a bad header, and a bad event line", () => {
    expect(() => parseJsonlArtifact("")).toThrow(/empty/);
    expect(() => parseJsonlArtifact("not-json\n")).toThrow(/unparsable header/);
    expect(() =>
      parseJsonlArtifact(
        [
          JSON.stringify({
            type: "session",
            version: 0,
            id: 42,
            createdAt: 1000,
            delegationDepth: 0,
          }),
        ].join("\n"),
      ),
    ).toThrow(/invalid header/);
    expect(() =>
      parseJsonlArtifact(
        [
          JSON.stringify({
            type: "session",
            version: 0,
            id: "s",
            createdAt: 1000,
            delegationDepth: 0,
          }),
          "not-json",
        ].join("\n"),
      ),
    ).toThrow(/unparsable event line/);
  });

  it("rejects a non-dense seq log", () => {
    expect(() =>
      parseJsonlArtifact(
        [
          JSON.stringify({
            type: "session",
            version: 0,
            id: "s",
            createdAt: 1000,
            delegationDepth: 0,
          }),
          JSON.stringify({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
        ].join("\n"),
      ),
    ).toThrow(/seq gap/);
  });
});

describe("parseImportZip", () => {
  it("extracts session.jsonl from a zip", async () => {
    const artifact = toJsonlArtifact(meta("roundtrip", "/work"), 0, oneTurnLog());
    const zip = await zipAsync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(artifact) });
    const parsed = await parseImportZip(zip);
    expect(parsed.meta).toMatchObject({ id: "roundtrip", cwd: "/work", isSeeded: false });
    expect(parsed.events).toEqual(oneTurnLog());
  });

  it("accepts the generation-addressed artifact name used by upstream export", async () => {
    const artifact = toJsonlArtifact(meta("v3", "/work"), 0, oneTurnLog());
    const zip = await zipAsync({ "session.v3.jsonl": strToU8(artifact) });
    const parsed = await parseImportZip(zip);
    expect(parsed.meta.id).toBe("v3");
    expect(parsed.events).toEqual(oneTurnLog());
  });

  it("rejects a corrupt zip and a zip without the artifact", async () => {
    await expect(parseImportZip(strToU8("not a zip"))).rejects.toThrow(/not a valid ZIP/);
    await expect(parseImportZip(await zipAsync({ other: strToU8("x") }))).rejects.toThrow(
      /no session log artifact/,
    );

    await expect(parseImportZip(await zipAsync({ "Session.jsonl": strToU8("x") }))).rejects.toThrow(
      /no session log artifact/,
    );
  });
});

describe("import round-trip through the backend", () => {
  it("imports a large batch beyond the single-INSERT binding limit", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const m = meta("big-src", "/work");
      const big = oneTurnLog();
      for (let turn = 1; turn < 2000; turn++) {
        big.push(
          ...oneTurnLog().map(
            (e) =>
              ({
                ...e,
                seq: SessionSeq(e.seq + big.length),
                time: e.time + turn * 10,
                data: { ...e.data, turn },
              }) as SessionEvent,
          ),
        );
      }
      await p.createAndAppend(m, big);

      const raw = await p.readRaw(m.id);
      expect(raw).toBeDefined();
      const parsed = await parseImportZip(
        await zipAsync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
      );
      const id = await persistImport(p, undefined, parsed);
      const loaded = await p.load(id);
      expect(loaded.events).toHaveLength(parsed.events.length);
      expect(loaded.events.map((e) => e.seq)).toEqual(
        Array.from({ length: loaded.events.length }, (_, k) => k),
      );
    } finally {
      await fiber.dispose();
    }
  });

  it("exports a session, imports it under a new id, and reloads identical events", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const m = meta("export-src", "/work");
      await p.createAndAppend(m, richLog());

      const raw = await p.readRaw(m.id);
      expect(raw).toBeDefined();

      expect(raw!.filename).toBe("session.v3.jsonl");
      const zip = await zipAsync({ [raw!.filename]: strToU8(raw!.content) });
      const parsed = await parseImportZip(zip);

      const importedId = `session-imported` as SessionId;
      await p.createAndAppend(
        { ...parsed.meta, id: importedId },
        parsed.events,
        parsed.inheritedEventCount,
      );

      const loaded = await p.load(importedId);
      expect(loaded.meta).toMatchObject({ cwd: "/work", isSeeded: false });

      expect(loaded.events.map((e) => e.type)).toEqual([
        "turn/start",
        "user/message",
        "step/start",
        "assistant/message",
        "step/end",
        "turn/end",
      ]);
      expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(
        (loaded.events[3] as SessionEvent & { sourceEventSeqs?: unknown }).sourceEventSeqs,
      ).toBeUndefined();
      const source = await p.load(m.id);
      expect(source.events).toEqual(loaded.events);
    } finally {
      await fiber.dispose();
    }
  });

  it("round-trips a seeded (forked) session's inherited boundary", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const seed = richLog().slice(0, 3);
      const childMeta = {
        ...meta("forked-child", "/work"),
        parentSession: SessionId("the-parent"),
        isSeeded: true,
      };

      const events = [
        ...seed,
        {
          type: "session/end-seed",
          seq: SessionSeq(3),
          time: 4,
          data: { inherited: true },
        } as unknown as SessionEvent,
        ...richLog()
          .slice(3)
          .map((e) => ({ ...e, seq: SessionSeq(e.seq + 1) })),
      ];
      await p.createAndAppend(childMeta, events, 3);

      const raw = await p.readRaw(childMeta.id);
      const parsed = await parseImportZip(
        await zipAsync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
      );
      expect(parsed.meta.isSeeded).toBe(true);
      expect(parsed.inheritedEventCount).toBe(3);
    } finally {
      await fiber.dispose();
    }
  });

  it("overwrites a target session's content when sessionId is supplied", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;

      const src = meta("export-src", "/work");
      await p.createAndAppend(src, richLog());

      const target = meta("target", "/other");
      await p.createAndAppend(target, oneTurnLog());
      const live = ctx.sessions.create(target.id, { meta: target, seed: [...oneTurnLog()] });
      await ctx.sessions.flush(live);

      expect(live.snapshotEvents()).toHaveLength(7);

      const raw = await p.readRaw(src.id);
      const parsed = await parseImportZip(
        await zipAsync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
      );

      const branch = ctx.get("sessionBranch") as unknown as {
        rewind(id: SessionId, toBoundary: number): Promise<unknown>;
      };
      expect(branch).toBeDefined();
      const id = await persistImport(p, branch, parsed, target.id, ctx.sessions);
      expect(id).toBe(target.id);
      const loaded = await p.load(target.id);
      expect(loaded.meta.id).toBe(target.id);
      expect(loaded.meta.cwd).toBe("/other");

      expect(loaded.events.map((e) => e.type)).toEqual([
        "turn/start",
        "user/message",
        "step/start",
        "assistant/message",
        "step/end",
        "turn/end",
      ]);

      const liveRead = ctx.sessions.get(target.id);
      expect(liveRead).toBeDefined();
      expect(liveRead!.snapshotEvents()).toEqual(loaded.events);
      expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);

      const source = await p.load(src.id);
      expect(source.events).toEqual(loaded.events);
    } finally {
      await fiber.dispose();
    }
  });

  it("keeps a pre-warmed token meter valid after an overwrite import (in-place log replacement)", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    new SessionProjectionRegistry(ctx);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const meter = new TokenMeter(ctx);

      const src = meta("meter-src", "/work");
      await p.createAndAppend(src, [...turnFrom(0, 1), ...turnFrom(6, 2), ...turnFrom(12, 3)]);

      // 目标先停在「turn 2 的 step 2 悬空未闭合」（中断运行的形状），预热后水位停在旧日志上
      const target = meta("meter-target", "/other");
      const targetSeed: SessionEvent[] = [
        ...richLog(),
        { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
        { type: "step/end", seq: SessionSeq(8), time: 9, data: { turn: 2, step: 1 } },
        { type: "step/start", seq: SessionSeq(9), time: 10, data: { turn: 2, step: 2 } },
      ];
      await p.createAndAppend(target, targetSeed);
      const live = ctx.sessions.create(target.id, { meta: target, seed: [...targetSeed] });
      await ctx.sessions.flush(live);

      expect(meter.measure(live).logRevision).toBe(live.snapshotEvents().length);

      const raw = await p.readRaw(src.id);
      const parsed = parseJsonlArtifact(raw!.content);

      const branch = ctx.get("sessionBranch") as unknown as {
        rewind(id: SessionId, toBoundary: number): Promise<unknown>;
        resetLiveDerivedState?(session: Session): void;
      };
      const invalidated: SessionId[] = [];
      const resetLiveDerivedState = branch.resetLiveDerivedState?.bind(branch);
      if (resetLiveDerivedState !== undefined) {
        branch.resetLiveDerivedState = (session) => {
          invalidated.push(session.id);
          resetLiveDerivedState(session);
        };
      }

      await persistImport(p, branch, parsed, target.id, ctx.sessions);

      // 覆盖导入整段替换内存 log：必须经过同一失效钩子，不能把水位留在被替换掉的旧日志上
      expect(invalidated).toEqual([target.id]);
      const measurement = meter.measure(live);
      expect(measurement.logRevision).toBe(live.snapshotEvents().length);
      expect(measurement).toEqual(freshMeasurement(live));
    } finally {
      await fiber.dispose();
    }
  });

  it("keeps a legitimate unclosed step tail when exporting and importing a whole log", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const src = meta("open-tail-src", "/work");
      const sourceLog: SessionEvent[] = [
        ...richLog(),
        { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
      ];
      await p.createAndAppend(src, sourceLog);

      const raw = await p.readRaw(src.id);
      const parsed = parseJsonlArtifact(raw!.content);
      expect(parsed.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      const importedId = await persistImport(p, undefined, parsed);
      const imported = await p.load(importedId);
      expect(imported.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      const session = Session.create(importedId, [...imported.events]);
      expect(freshMeasurement(session).logRevision).toBe(session.snapshotEvents().length);
    } finally {
      await fiber.dispose();
    }
  });

  it("drops the tail from an orphan step/end when exporting and importing a whole log", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const src = meta("orphan-src", "/work");
      const sourceLog: SessionEvent[] = [
        ...richLog(),
        { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        { type: "step/end", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
        {
          type: "turn/end",
          seq: SessionSeq(8),
          time: 9,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      ];
      await p.createAndAppend(src, sourceLog);

      const raw = await p.readRaw(src.id);
      const parsed = parseJsonlArtifact(raw!.content);
      expect(parsed.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);

      const importedId = await persistImport(p, undefined, parsed);
      const imported = await p.load(importedId);
      expect(imported.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);

      const session = Session.create(importedId, [...imported.events]);
      expect(freshMeasurement(session).logRevision).toBe(session.snapshotEvents().length);
    } finally {
      await fiber.dispose();
    }
  });

  it("stops the target session's running loop before the overwrite rewind", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const src = meta("export-src", "/work");
      await p.createAndAppend(src, richLog());

      const target = meta("target-busy", "/other");
      await p.createAndAppend(target, oneTurnLog());
      const live = ctx.sessions.create(target.id, { meta: target, seed: [...oneTurnLog()] });
      await ctx.sessions.flush(live);
      const before = live.snapshotEvents().length;

      const calls: string[] = [];
      const cancels: Array<{ cause: unknown; options: unknown }> = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionId) =>
          id === target.id
            ? {
                session: live,
                cancel: (cause: unknown, options: unknown) => {
                  calls.push("cancel");
                  cancels.push({ cause, options });
                },
                whenIdle: async () => {
                  calls.push("whenIdle");

                  expect(live.snapshotEvents()).toHaveLength(before);
                },
              }
            : undefined,
      });

      const routes = new Map<string, (req: unknown, res: unknown) => void | Promise<void>>();
      ctx.provide("webServer", {
        register: (route: {
          path: string;
          handler: (req: unknown, res: unknown) => void | Promise<void>;
        }) => {
          routes.set(route.path, route.handler);
          return () => {};
        },
      });
      ctx.provide("connection", { requestRejection: () => undefined });
      registerSessionImport(ctx, p);
      for (let i = 0; i < 1000 && !routes.has(SESSION_IMPORT_PATH); i += 1) await Promise.resolve();
      expect(routes.has(SESSION_IMPORT_PATH)).toBe(true);

      const raw = await p.readRaw(src.id);
      const zip = Buffer.from(
        await zipAsync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
      ).toString("base64");
      const response = fakeResponse();
      await routes.get(SESSION_IMPORT_PATH)!(
        fakeJsonRequest({ zip, sessionId: target.id }),
        response.res,
      );

      expect(response.code).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ sessionId: target.id });

      expect(calls).toEqual(["cancel", "whenIdle"]);
      expect(cancels[0]).toEqual({ cause: { kind: "user" }, options: { keepInbox: true } });
      const loaded = await p.load(target.id);
      expect(loaded.events.map((e) => e.type)).toEqual([
        "turn/start",
        "user/message",
        "step/start",
        "assistant/message",
        "step/end",
        "turn/end",
      ]);
      disposeAgents();
    } finally {
      await fiber.dispose();
    }
  });

  it("mints a new id when sessionId is omitted", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const p = ctx.sessionPersistence as SessionPersistenceSqlite;
      const src = meta("new-src", "/work");
      await p.createAndAppend(src, oneTurnLog());
      const raw = await p.readRaw(src.id);
      const parsed = await parseImportZip(
        await zipAsync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
      );

      const id = await persistImport(p, undefined, parsed);
      expect(id).not.toBe(src.id);
      const loaded = await p.load(id);
      expect(loaded.events).toEqual(oneTurnLog());
    } finally {
      await fiber.dispose();
    }
  });
});
