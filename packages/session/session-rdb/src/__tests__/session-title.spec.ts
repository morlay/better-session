/**
 * 会话标题作为会话数据（`t_sessions.f_title` / `f_title_seq`）：
 * - 写路径遇到 `session/title` 事件即刷新该列；
 * - rewind 截断掉标题事件后列随之回退；
 * - 列表消费（投影缓存读路径）在没有 checkpoint 行时直接取该列。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SessionStore,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionPersistenceSqlite from "@morlay/session-rdb";
import { EmptySettings, meta, oneTurnLog } from "@morlay/session-rdb/testing";
import { titleOfEventData } from "../log.ts";
import { SqliteBackend } from "../sqlite.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** 一条 `session/title` 事件（上游 title unit 的输入）。 */
function titleEvent(title: string, seq: number): SessionEvent {
  return {
    type: "session/title",
    seq: SessionSeq(seq),
    time: seq + 1,
    data: { title, messageSeqs: [], source: "auto" },
  } as unknown as SessionEvent;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the service");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("session title as session data", () => {
  it("maintains the title column from title events and rewinds it", async () => {
    const root = await tempDir("session-title-");
    const dbPath = join(root, "sessions.sqlite");
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: dbPath });
    try {
      const id = SessionId("titled");
      ctx.sessions.create(id, {
        meta: meta("titled"),
        seed: [...oneTurnLog(), titleEvent("第一个标题", 6)],
      });
      const live = ctx.sessions.get(id)!;
      await ctx.sessions.flush(live);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT f_title, f_title_seq FROM t_sessions WHERE f_session_id = 'titled'")
          .get() as { f_title: string; f_title_seq: number };
        expect(row.f_title).toBe("第一个标题");
        expect(row.f_title_seq).toBe(6);
      } finally {
        db.close();
      }

      // 截断掉标题事件（保留到 turn/end = seq 5）→ 标题列回退为空。
      await ctx.sessionBranch.rewind(id, 5);
      const after = new DatabaseSync(dbPath);
      try {
        const row = after
          .prepare("SELECT f_title, f_title_seq FROM t_sessions WHERE f_session_id = 'titled'")
          .get() as { f_title: string | null; f_title_seq: number | null };
        expect(row.f_title).toBeNull();
        expect(row.f_title_seq).toBeNull();
      } finally {
        after.close();
      }
    } finally {
      await fiber.dispose();
    }
  });

  it("serves the title straight from the session row when no checkpoint row exists", async () => {
    const root = await tempDir("session-title-");
    const dbPath = join(root, "sessions.sqlite");
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    new SessionProjectionRegistry(ctx);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: dbPath });
    try {
      const cache = await waitFor(
        () =>
          ctx.get("sessionProjectionCache") as
            | {
                cachedSnapshot(
                  header: SessionHeader,
                  inherited: SessionLogOffset,
                  keys?: readonly string[],
                ): { asOfSeq: number; values: Record<string, unknown> } | undefined;
              }
            | undefined,
      );
      const id = SessionId("titled");
      ctx.sessions.create(id, {
        meta: meta("titled"),
        seed: [...oneTurnLog(), titleEvent("直取标题", 6)],
      });
      const live = ctx.sessions.get(id)!;
      await ctx.sessions.flush(live);

      // 没有调用过 write：checkpoint 行不存在，title 直接来自会话列。
      const snapshot = cache.cachedSnapshot(live.header, live.inheritedEventCount, ["title"]);
      expect(snapshot?.values["title"]).toBe("直取标题");
      expect(snapshot?.asOfSeq).toBe(6);
    } finally {
      await fiber.dispose();
    }
  });

  it("extracts titles from current and legacy event shapes", () => {
    expect(titleOfEventData('{"type":"session/title","data":{"title":"当前"}}')).toBe("当前");
    // 旧世代（v0-v2）的 f_data 直接平铺事件 data。
    expect(titleOfEventData('{"title":"旧世代","messageSeqs":[1]}')).toBe("旧世代");
    expect(titleOfEventData('{"data":{}}')).toBeUndefined();
    expect(titleOfEventData("not json")).toBeUndefined();
  });

  it("backfills legacy titles through the correction migration", async () => {
    const root = await tempDir("session-title-");
    const dbPath = join(root, "sessions.sqlite");
    const backend = new SqliteBackend({ path: dbPath, journalMode: "wal", busyTimeout: 5000 });
    await backend.open();
    try {
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          "INSERT INTO t_sessions (f_session_id, f_version, f_created_at, f_incarnation, f_revision) " +
            "VALUES ('legacy', 0, 1, 'seed', 0)",
        ).run();
        db.prepare(
          "INSERT INTO t_events (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding, f_data, f_created_at) " +
            "VALUES ('e1', '', 'session/title', 'lifecycle', '', '', '', 'json', ?, 1)",
        ).run(
          JSON.stringify({ title: "旧世代标题", messageSeqs: [1], source: { kind: "fallback" } }),
        );
        db.prepare(
          "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_surface_op) VALUES ('legacy', 'e1', 3, NULL)",
        ).run();

        const sql = await readFile(
          new URL(
            "../../drizzle/sqlite/20260910130000_v3_session_title_backfill/migration.sql",
            import.meta.url,
          ),
          "utf8",
        );
        db.exec(sql.replaceAll("--> statement-breakpoint", ""));
        const row = db
          .prepare("SELECT f_title, f_title_seq FROM t_sessions WHERE f_session_id = 'legacy'")
          .get() as { f_title: string; f_title_seq: number };
        expect(row.f_title).toBe("旧世代标题");
        expect(row.f_title_seq).toBe(3);
      } finally {
        db.close();
      }
    } finally {
      await backend.close();
    }
  });
});
