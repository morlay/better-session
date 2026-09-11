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
} from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { strToU8, zipSync } from "fflate";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { toJsonlArtifact } from "@morlay/session-rdb/artifact";
import { EmptySettings } from "@morlay/session-rdb/testing";
import { meta, oneTurnLog } from "@morlay/session-rdb/testing";
import {
  SESSION_LOG_ARTIFACT_FILENAME,
  parseImportZip,
  parseJsonlArtifact,
  persistImport,
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
    // 历史 v0 artifact：消息无 id、assistant/message 用 content/provenance
    // 顶层字段。导入时经上游迁移链转当前逻辑事件（补 id、嵌入 stream，并在
    // 首个 step 后注入 system head）。surface 事件必须排在 step 内——上游
    // v2→v3 迁移拒绝 pre-step surface，而不是重排来源历史。
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
    // 继承前缀按目标坐标计：源前缀 2 个事件 + 迁移注入的 system head = 3。
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
  it("extracts session.jsonl from a zip", () => {
    const artifact = toJsonlArtifact(meta("roundtrip", "/work"), 0, oneTurnLog());
    const zip = zipSync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(artifact) });
    const parsed = parseImportZip(zip);
    expect(parsed.meta).toMatchObject({ id: "roundtrip", cwd: "/work", isSeeded: false });
    expect(parsed.events).toEqual(oneTurnLog());
  });

  it("rejects a corrupt zip and a zip without the artifact", () => {
    expect(() => parseImportZip(strToU8("not a zip"))).toThrow(/not a valid ZIP/);
    expect(() => parseImportZip(zipSync({ other: strToU8("x") }))).toThrow(
      /missing session\.jsonl/,
    );
  });
});

describe("import round-trip through the backend", () => {
  it("imports a large batch beyond the single-INSERT binding limit", async () => {
    // SQLite 单条多行 INSERT 的绑定参数上限 32766（10 列 × 3276 行）；
    // 超过上限时后端必须分批落库而不是 prepare 失败。
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
      const parsed = parseImportZip(
        zipSync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
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
      const zip = zipSync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) });
      const parsed = parseImportZip(zip);
      // 导入以新 id 落库：源会话保持不变。
      const importedId = `session-imported` as SessionId;
      await p.createAndAppend(
        { ...parsed.meta, id: importedId },
        parsed.events,
        parsed.inheritedEventCount,
      );

      const loaded = await p.load(importedId);
      expect(loaded.meta).toMatchObject({ cwd: "/work", isSeeded: false });
      // 原样存储：导出→导入 round-trip 还原完整事件（6 事件，seq 0..5）。
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
      // v2 seeded 会话：继承前缀末尾必须带 session/end-seed {inherited} marker。
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
      const parsed = parseImportZip(
        zipSync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
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
      // 源会话 A：将被导出。
      const src = meta("export-src", "/work");
      await p.createAndAppend(src, richLog());
      // 目标会话 B：已有旧内容（导出前会被 rewind 清空），且保持 live
      // （observeSession 优先读 live 内存快照——覆盖后必须同步回导入事件）。
      const target = meta("target", "/other");
      await p.createAndAppend(target, oneTurnLog());
      const live = ctx.sessions.create(target.id, { meta: target, seed: [...oneTurnLog()] });
      await ctx.sessions.flush(live);
      // seed 构造会自动补 session/end-seed：6 事件 + 1 标记 = 7。
      expect(live.snapshotEvents()).toHaveLength(7);

      const raw = await p.readRaw(src.id);
      const parsed = parseImportZip(
        zipSync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
      );
      // 覆盖：rewind(-1) 清空 target（真实 branch 服务同步 coordinator
      // cursor 与内存 log）后追加导入事件。
      const branch = ctx.get("sessionBranch") as unknown as {
        rewind(id: SessionId, toBoundary: number): Promise<unknown>;
      };
      expect(branch).toBeDefined();
      const id = await persistImport(p, branch, parsed, target.id, ctx.sessions);
      expect(id).toBe(target.id);
      const loaded = await p.load(target.id);
      expect(loaded.meta.id).toBe(target.id);
      expect(loaded.meta.cwd).toBe("/other"); // 覆盖不改变身份/cwd
      // 目标会话内容 = 源会话的稠密持久化视图（无 delta/provenance）。
      expect(loaded.events.map((e) => e.type)).toEqual([
        "turn/start",
        "user/message",
        "step/start",
        "assistant/message",
        "step/end",
        "turn/end",
      ]);
      // live 内存同步：observeSession 路径（live 命中）读到与 DB 一致的事件。
      const liveRead = ctx.sessions.get(target.id);
      expect(liveRead).toBeDefined();
      expect(liveRead!.snapshotEvents()).toEqual(loaded.events);
      expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      // 源会话保持不变。
      const source = await p.load(src.id);
      expect(source.events).toEqual(loaded.events);
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
      const parsed = parseImportZip(
        zipSync({ [SESSION_LOG_ARTIFACT_FILENAME]: strToU8(raw!.content) }),
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
