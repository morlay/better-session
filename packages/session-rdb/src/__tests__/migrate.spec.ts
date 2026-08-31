/**
 * v1 → v2 迁移脚本测试：构造 v1 表结构（旧坐标模型）→ 跑迁移 → 验证 v2
 * 表结构与数据正确（f_type/f_kind/f_role/f_name/f_action_id 重算、
 * f_original_seq/f_surface_op 迁移到桥接行）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-migrate-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

/** 构造 v1 表结构 + 一行事件 + 一行桥接。 */
function createV1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA application_id = 0x44534850;
    PRAGMA user_version = 1;
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
      f_kind TEXT NOT NULL DEFAULT '',
      f_role TEXT NOT NULL DEFAULT '',
      f_name TEXT NOT NULL DEFAULT '',
      f_action_id TEXT NOT NULL DEFAULT '',
      f_encoding TEXT NOT NULL DEFAULT '',
      f_data TEXT NOT NULL,
      f_created_at INTEGER NOT NULL DEFAULT 0,
      f_original_seq INTEGER NOT NULL,
      f_source_event_seqs TEXT,
      f_surface_op TEXT
    ) STRICT;
    CREATE TABLE t_session_events (
      f_id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_session_id TEXT NOT NULL REFERENCES t_sessions(f_session_id) ON DELETE CASCADE,
      f_event_id TEXT NOT NULL REFERENCES t_events(f_event_id) ON DELETE CASCADE,
      f_sequence INTEGER NOT NULL,
      UNIQUE (f_session_id, f_sequence)
    ) STRICT;
    INSERT INTO t_persistence_state (f_singleton, f_store_id) VALUES (1, 'store-1');
    INSERT INTO t_sessions
      (f_session_id, f_head_event_id, f_head_sequence, f_version, f_created_at, f_cwd,
       f_parent_session, f_seed_length, f_origin, f_delegation_depth, f_incarnation, f_revision)
    VALUES ('s1', 'evt-1', 1, 0, 1000, '/work', NULL, NULL, NULL, NULL, 'inc-1', 1);
    INSERT INTO t_events
      (f_event_id, f_parent_id, f_kind, f_role, f_name, f_action_id, f_encoding,
       f_data, f_created_at, f_original_seq, f_source_event_seqs, f_surface_op)
    VALUES ('evt-1', '', 'user/message', 'user', '', '', 'json',
            '{"content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}',
            1000, 0, NULL, '"append"');
    INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence)
    VALUES ('s1', 'evt-1', 0);
  `);
  db.close();
}

/** 跑迁移脚本（子进程，独立于测试进程的模块状态）。 */
function runMigration(path: string): void {
  const script = fileURLToPath(new URL("../../scripts/migrate-v1-to-v2.mts", import.meta.url));
  execFileSync(process.execPath, ["--import", "tsx", script, path], {
    stdio: "pipe",
  });
}

describe("migrate v1 → v2", () => {
  it("migrates tables and data to the v2 shape", async () => {
    const path = await freshDbPath();
    createV1Database(path);
    runMigration(path);

    const db = new DatabaseSync(path, { readOnly: true });
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version).toBe(2);

    // t_events：f_type = 旧 f_kind，维度列重算。
    const event = db
      .prepare(
        `SELECT f_type, f_kind, f_role, f_name, f_action_id, f_data FROM t_events WHERE f_event_id = 'evt-1'`,
      )
      .get() as {
      f_type: string;
      f_kind: string;
      f_role: string;
      f_name: string;
      f_action_id: string;
      f_data: string;
    };
    expect(event.f_type).toBe("user/message");
    expect(event.f_kind).toBe("message");
    expect(event.f_role).toBe("user");
    expect(event.f_name).toBe("");
    expect(event.f_action_id).toBe("");
    expect(JSON.parse(event.f_data)).toEqual({
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    });

    // t_session_events：f_original_seq / f_surface_op 从旧 t_events 迁移。
    const bridge = db
      .prepare(
        `SELECT f_sequence, f_original_seq, f_surface_op FROM t_session_events WHERE f_session_id = 's1'`,
      )
      .get() as { f_sequence: number; f_original_seq: number; f_surface_op: string };
    expect(bridge.f_sequence).toBe(0);
    expect(bridge.f_original_seq).toBe(0);
    expect(bridge.f_surface_op).toBe('"append"');

    // 旧列已删除。
    const eventColumns = db
      .prepare("PRAGMA table_info(t_events)")
      .all() as Array<{ name: string }>;
    expect(eventColumns.map((c) => c.name)).not.toContain("f_original_seq");
    expect(eventColumns.map((c) => c.name)).not.toContain("f_source_event_seqs");
    expect(eventColumns.map((c) => c.name)).not.toContain("f_surface_op");
    expect(eventColumns.map((c) => c.name)).toContain("f_type");
    db.close();
  });

  it("is a no-op on an already-v2 database", async () => {
    const path = await freshDbPath();
    createV1Database(path);
    runMigration(path);
    // 第二次跑：已是 v2，直接返回。
    runMigration(path);
    const db = new DatabaseSync(path, { readOnly: true });
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version).toBe(2);
    db.close();
  });
});
