import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite from "@morlay/session-rdb";

/** 类型收窄：ctx.sessionPersistence 到 RDB 子类（便捷方法面）。 */
function rdb(ctx: Context): SessionPersistenceSqlite {
  return ctx.sessionPersistence as SessionPersistenceSqlite;
}
import { EmptySettings } from "@morlay/session-rdb/testing";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-migrate-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

/** 建 v2 形状库（已发布形状：t_session_events 带 f_original_seq、无 t_schema_meta）。 */
function createV2Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA application_id = 0x44534850;
    PRAGMA user_version = 2;
    CREATE TABLE t_persistence_state (
      f_id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_singleton INTEGER NOT NULL UNIQUE,
      f_store_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE t_sessions (
      f_id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_session_id TEXT NOT NULL UNIQUE,
      f_head_event_id TEXT NOT NULL DEFAULT '',
      f_head_sequence INTEGER NOT NULL DEFAULT -1,
      f_version INTEGER NOT NULL,
      f_created_at INTEGER NOT NULL,
      f_cwd TEXT,
      f_parent_session TEXT,
      f_seed_length INTEGER,
      f_origin TEXT,
      f_delegation_depth INTEGER,
      f_incarnation TEXT NOT NULL,
      f_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE t_events (
      f_id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_event_id TEXT NOT NULL UNIQUE,
      f_parent_id TEXT NOT NULL DEFAULT '',
      f_type TEXT NOT NULL DEFAULT '',
      f_kind TEXT NOT NULL DEFAULT '',
      f_role TEXT NOT NULL DEFAULT '',
      f_name TEXT NOT NULL DEFAULT '',
      f_action_id TEXT NOT NULL DEFAULT '',
      f_encoding TEXT NOT NULL DEFAULT '',
      f_data TEXT NOT NULL,
      f_created_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE t_session_events (
      f_id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_session_id TEXT NOT NULL REFERENCES t_sessions(f_session_id) ON DELETE CASCADE,
      f_event_id TEXT NOT NULL REFERENCES t_events(f_event_id) ON DELETE CASCADE,
      f_sequence INTEGER NOT NULL,
      f_original_seq INTEGER NOT NULL,
      f_surface_op TEXT,
      UNIQUE (f_session_id, f_sequence)
    ) STRICT;
    INSERT INTO t_persistence_state (f_singleton, f_store_id) VALUES (1, 'store-1');
    INSERT INTO t_sessions
      (f_session_id, f_head_event_id, f_head_sequence, f_version, f_created_at, f_cwd,
       f_parent_session, f_seed_length, f_origin, f_delegation_depth, f_incarnation, f_revision)
    VALUES ('s1', 'evt-1', 1, 2, 1000, '/work', NULL, NULL, NULL, NULL, 'inc-1', 1);
    INSERT INTO t_events
      (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding,
       f_data, f_created_at)
    VALUES ('evt-1', '', 'user/message', 'message', 'user', '', '', 'json',
            '{"id":"u1","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}',
            1000);
    INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op)
    VALUES ('s1', 'evt-1', 0, 0, '"append"');
  `);
  db.close();
}

describe("migrate v2 → v3", () => {
  it("auto-migrates a v2 database on backend open (drizzle-kit v3 diff)", async () => {
    const path = await freshDbPath();
    createV2Database(path);

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      // 迁移后会话可正常读取（v3 形状）。
      const loaded = await rdb(ctx).load(SessionId("s1"));
      expect(loaded.events).toHaveLength(1);
      expect(loaded.events[0]?.type).toBe("user/message");
      expect(loaded.events[0]?.seq).toBe(0);
    } finally {
      await fiber.dispose();
    }

    const db = new DatabaseSync(path, { readOnly: true });
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version).toBe(3);
    // v3 diff：t_session_events 删 f_original_seq、建 t_schema_meta。
    const bridgeColumns = db.prepare("PRAGMA table_info(t_session_events)").all() as Array<{
      name: string;
    }>;
    expect(bridgeColumns.map((c) => c.name)).not.toContain("f_original_seq");
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't_schema_meta'")
        .get(),
    ).toEqual({ name: "t_schema_meta" });
    db.close();
  });

  it("is a no-op on an already-v3 database (migrations recorded as applied)", async () => {
    const path = await freshDbPath();
    createV2Database(path);

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    await fiber.dispose();
    // 第二次打开：迁移已记录，不重复执行。
    const ctx2 = new Context();
    await ctx2.plugin(EmptySettings);
    await ctx2.plugin(SessionStore);
    const fiber2 = await ctx2.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    const loaded = await rdb(ctx2).load(SessionId("s1"));
    expect(loaded.events).toHaveLength(1);
    await fiber2.dispose();

    const db = new DatabaseSync(path, { readOnly: true });
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version).toBe(3);
    db.close();
  });

  it("reads a v0-format session through the legacy conversion chain (no id messages, old assistant shape)", async () => {
    // 历史 v0 数据：f_version = 0，消息无 id、assistant/message 用旧形状
    // （content/provenance 顶层字段）。读取时经上游迁移链转 v2 逻辑事件。
    const path = await freshDbPath();
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA application_id = 0x44534850;
      PRAGMA user_version = 2;
      CREATE TABLE t_persistence_state (
        f_id INTEGER PRIMARY KEY AUTOINCREMENT,
        f_singleton INTEGER NOT NULL UNIQUE,
        f_store_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE t_sessions (
        f_id INTEGER PRIMARY KEY AUTOINCREMENT,
        f_session_id TEXT NOT NULL UNIQUE,
        f_head_event_id TEXT NOT NULL DEFAULT '',
        f_head_sequence INTEGER NOT NULL DEFAULT -1,
        f_version INTEGER NOT NULL,
        f_created_at INTEGER NOT NULL,
        f_cwd TEXT,
        f_parent_session TEXT,
        f_seed_length INTEGER,
        f_origin TEXT,
        f_delegation_depth INTEGER,
        f_incarnation TEXT NOT NULL,
        f_revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE t_events (
        f_id INTEGER PRIMARY KEY AUTOINCREMENT,
        f_event_id TEXT NOT NULL UNIQUE,
        f_parent_id TEXT NOT NULL DEFAULT '',
        f_type TEXT NOT NULL DEFAULT '',
        f_kind TEXT NOT NULL DEFAULT '',
        f_role TEXT NOT NULL DEFAULT '',
        f_name TEXT NOT NULL DEFAULT '',
        f_action_id TEXT NOT NULL DEFAULT '',
        f_encoding TEXT NOT NULL DEFAULT '',
        f_data TEXT NOT NULL,
        f_created_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE t_session_events (
        f_id INTEGER PRIMARY KEY AUTOINCREMENT,
        f_session_id TEXT NOT NULL REFERENCES t_sessions(f_session_id) ON DELETE CASCADE,
        f_event_id TEXT NOT NULL REFERENCES t_events(f_event_id) ON DELETE CASCADE,
        f_sequence INTEGER NOT NULL,
        f_original_seq INTEGER NOT NULL,
        f_surface_op TEXT,
        UNIQUE (f_session_id, f_sequence)
      ) STRICT;
      INSERT INTO t_persistence_state (f_singleton, f_store_id) VALUES (1, 'store-legacy');
      INSERT INTO t_sessions
        (f_session_id, f_head_event_id, f_head_sequence, f_version, f_created_at, f_cwd,
         f_parent_session, f_seed_length, f_origin, f_delegation_depth, f_incarnation, f_revision)
      VALUES ('v0-session', 'evt-3', 3, 0, 1000, '/work', NULL, NULL, NULL, NULL, 'inc-0', 1);
      INSERT INTO t_events
        (f_event_id, f_parent_id, f_type, f_kind, f_role, f_name, f_action_id, f_encoding,
         f_data, f_created_at)
      VALUES
        ('evt-0', '', 'turn/start', 'turn', '', '', '', 'json',
         '{"turn":1}', 1000),
        ('evt-1', 'evt-0', 'user/message', 'message', 'user', '', '', 'json',
         '{"content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}', 1001),
        ('evt-2', 'evt-1', 'step/start', 'turn', '', '', '', 'json',
         '{"turn":1,"step":1}', 1002),
        ('evt-3', 'evt-2', 'assistant/message', 'message', 'assistant', '', '', 'json',
         '{"turn":1,"step":1,"content":[{"type":"text","text":"hello"}],"provenance":{"provider":"mock","model":"mock"}}', 1003);
      INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op)
      VALUES
        ('v0-session', 'evt-0', 0, 0, NULL),
        ('v0-session', 'evt-1', 1, 1, '"append"'),
        ('v0-session', 'evt-2', 2, 2, NULL),
        ('v0-session', 'evt-3', 3, 3, '"append"');
    `);
    db.close();

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const loaded = await rdb(ctx).load(SessionId("v0-session"));
      // 迁移链补 id / 旧形状转 v2（assistant/message 嵌入 stream）。
      expect(loaded.meta.version).toBe(2);
      expect(loaded.events).toHaveLength(4);
      const user = loaded.events[1]!;
      expect(user.type).toBe("user/message");
      expect(
        user.type === "user/message" && typeof user.data.id === "string" && user.data.id.length > 0,
      ).toBe(true);
      const assistant = loaded.events[3]!;
      expect(assistant.type).toBe("assistant/message");
      expect(
        assistant.type === "assistant/message" &&
          Array.isArray(assistant.data.stream) &&
          assistant.data.message.source.kind === "model",
      ).toBe(true);
    } finally {
      await fiber.dispose();
    }
  });
});
