import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context } from "@deepseek-ai/cordis";
import {
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SessionStore,
  SESSION_FORMAT_VERSION,
} from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite from "@morlay/session-rdb";

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
        ('evt-1', 'evt-0', 'step/start', 'turn', '', '', '', 'json',
         '{"turn":1,"step":1}', 1001),
        ('evt-2', 'evt-1', 'user/message', 'message', 'user', '', '', 'json',
         '{"content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}', 1002),
        ('evt-3', 'evt-2', 'assistant/message', 'message', 'assistant', '', '', 'json',
         '{"turn":1,"step":1,"content":[{"type":"text","text":"hello"}],"provenance":{"provider":"mock","model":"mock"}}', 1003);
      INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op)
      VALUES
        ('v0-session', 'evt-0', 0, 0, NULL),
        ('v0-session', 'evt-1', 1, 1, NULL),
        ('v0-session', 'evt-2', 2, 2, '"append"'),
        ('v0-session', 'evt-3', 3, 3, '"append"');
    `);
    db.close();

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const loaded = await rdb(ctx).load(SessionId("v0-session"));

      expect(loaded.meta.version).toBe(SESSION_FORMAT_VERSION);
      expect(loaded.events).toHaveLength(5);
      expect(loaded.events[2]?.type).toBe("system/message");
      const user = loaded.events[3]!;
      expect(user.type).toBe("user/message");
      expect(
        user.type === "user/message" && typeof user.data.id === "string" && user.data.id.length > 0,
      ).toBe(true);
      const assistant = loaded.events[4]!;
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

  it("migrates a v2 session through the chain: in-step surface keeps chronology and promotes the system prompt to a head", async () => {
    const path = await freshDbPath();
    createV0SessionDatabase(
      path,
      [
        { id: "evt-0", type: "turn/start", data: '{"turn":1}', surfaceOp: null },
        { id: "evt-1", type: "step/start", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-2",
          type: "user/message",
          data: '{"id":"u1","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}',
          surfaceOp: '"append"',
        },
        {
          id: "evt-3",
          type: "request/header",
          data: '{"reason":"initial","header":{"config":{"provider":"mock","model":"mock"},"system":"sys prompt"}}',
          surfaceOp: null,
        },
        {
          id: "evt-4",
          type: "assistant/message",
          data: '{"turn":1,"step":1,"message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}},"stream":[]}',
          surfaceOp: '"append"',
        },
        { id: "evt-5", type: "step/end", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-6",
          type: "turn/end",
          data: '{"turn":1,"reason":{"kind":"completed"}}',
          surfaceOp: null,
        },
      ],
      { version: 2 },
    );

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const loaded = await rdb(ctx).load(SessionId("v0-session"));
      expect(loaded.meta.version).toBe(SESSION_FORMAT_VERSION);

      expect(loaded.events).toHaveLength(9);
      const emptyHead = loaded.events[2]!;
      expect(emptyHead.type).toBe("system/message");
      expect(emptyHead.type === "system/message" && emptyHead.data.message.content).toEqual([]);
      const head = loaded.events[4]!;
      expect(head.type).toBe("system/message");
      expect(head.type === "system/message" && head.data.message.content).toEqual([
        { type: "text", text: "sys prompt" },
      ]);
      const request = loaded.events[5]!;
      expect(request.type).toBe("request/header");
      expect(
        request.type === "request/header" &&
          Object.hasOwn(request.data.header as unknown as object, "system"),
      ).toBe(false);
    } finally {
      await fiber.dispose();
    }
  });

  it("adopts a pre-step v2 session and normalizes request/header to the v3 shape", async () => {
    const path = await freshDbPath();
    createV0SessionDatabase(
      path,
      [
        { id: "evt-0", type: "turn/start", data: '{"turn":1}', surfaceOp: null },
        {
          id: "evt-1",
          type: "user/message",
          data: '{"id":"u1","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}',
          surfaceOp: '"append"',
        },
        { id: "evt-2", type: "step/start", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-3",
          type: "request/header",
          data: '{"reason":"initial","header":{"config":{"provider":"mock","model":"mock"},"system":"sys prompt","tools":[],"adapterDefaults":{}}}',
          surfaceOp: null,
        },
        {
          id: "evt-4",
          type: "assistant/message",
          data: '{"turn":1,"step":1,"message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}},"stream":[]}',
          surfaceOp: '"append"',
        },
        { id: "evt-5", type: "step/end", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-6",
          type: "turn/end",
          data: '{"turn":1,"reason":{"kind":"completed"}}',
          surfaceOp: null,
        },
      ],
      { version: 2 },
    );

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const loaded = await rdb(ctx).load(SessionId("v0-session"));
      expect(loaded.meta.version).toBe(SESSION_FORMAT_VERSION);
      expect(loaded.events).toHaveLength(7);
      expect(loaded.events.some((event) => event.type === "system/message")).toBe(false);
      const request = loaded.events[3]!;
      expect(request.type).toBe("request/header");
      const header =
        request.type === "request/header"
          ? (request.data.header as unknown as Record<string, unknown>)
          : {};
      expect(Object.hasOwn(header, "system")).toBe(false);
      expect(Object.hasOwn(header, "tools")).toBe(false);
      expect(Object.hasOwn(header, "adapterDefaults")).toBe(false);
      expect(header["config"]).toEqual({ provider: "mock", model: "mock" });
    } finally {
      await fiber.dispose();
    }
  });

  it("loads a session whose replace range escaped into the old coordinate space (repair precedes validation)", async () => {
    const path = await freshDbPath();
    createV0SessionDatabase(
      path,
      [
        { id: "evt-0", type: "turn/start", data: '{"turn":1}', surfaceOp: null },
        {
          id: "evt-1",
          type: "user/message",
          data: '{"id":"u1","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}',
          surfaceOp: '"append"',
        },
        { id: "evt-2", type: "step/start", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-3",
          type: "assistant/message",
          data: '{"turn":1,"step":1,"message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}},"stream":[]}',
          surfaceOp: '"append"',
        },
        { id: "evt-4", type: "step/end", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-5",
          type: "turn/end",
          data: '{"turn":1,"reason":{"kind":"completed"}}',
          surfaceOp: null,
        },
        {
          id: "evt-6",
          type: "compaction/summary",
          data: '{"turn":1,"summary":[{"type":"text","text":"s"}],"shadowedRange":{"start":1,"end":3},"shadowedSeqs":[1,3],"shadowedTokenCount":10}',
          surfaceOp: null,
        },
        {
          id: "evt-7",
          type: "user/message",
          data: '{"id":"ckpt","role":"user","content":[{"type":"text","text":"checkpoint"}],"source":{"kind":"plugin","plugin":"compact"}}',
          surfaceOp: '{"op":"replace","start":1,"end":9999}',
        },
        { id: "evt-8", type: "compaction/end", data: '{"turn":1}', surfaceOp: null },
      ],
      { version: 2 },
    );

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const loaded = await rdb(ctx).load(SessionId("v0-session"));
      expect(loaded.meta.version).toBe(SESSION_FORMAT_VERSION);
      const checkpoint = loaded.events[7]!;
      expect(checkpoint.type).toBe("user/message");

      expect(checkpoint.surfaceOp).toEqual({
        op: "replace",
        startSeq: SessionSeq(1),
        endSeq: SessionSeq(3),
      });
      expect(() =>
        Session.fromRestore(
          SessionId("v0-session"),
          loaded.events,
          loaded.meta,
          SessionLogOffset(loaded.inheritedEventCount),
          "detached",
        ),
      ).not.toThrow();
    } finally {
      await fiber.dispose();
    }
  });

  it("renames v2 PTC vocabulary in the adopted view (tool/code-dispatch-* and tools-code-mode)", async () => {
    const path = await freshDbPath();
    createV0SessionDatabase(
      path,
      [
        { id: "evt-0", type: "turn/start", data: '{"turn":1}', surfaceOp: null },
        {
          id: "evt-1",
          type: "user/message",
          data: '{"id":"u1","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"plugin","plugin":"tools-code-mode"}}',
          surfaceOp: '"append"',
        },
        { id: "evt-2", type: "step/start", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-3",
          type: "tool/code-dispatch-start",
          data: '{"rootCallId":"r1","parentCallId":"r1","subCallId":"r1:code:1","name":"bash","arguments":{}}',
          surfaceOp: null,
        },
        {
          id: "evt-4",
          type: "tool/code-dispatch",
          data: '{"rootCallId":"r1","parentCallId":"r1","subCallId":"r1:code:1","name":"bash","arguments":{},"isError":false,"content":[]}',
          surfaceOp: null,
        },
        {
          id: "evt-5",
          type: "assistant/message",
          data: '{"turn":1,"step":1,"message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}},"stream":[]}',
          surfaceOp: '"append"',
        },
        { id: "evt-6", type: "step/end", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-7",
          type: "turn/end",
          data: '{"turn":1,"reason":{"kind":"completed"}}',
          surfaceOp: null,
        },
      ],
      { version: 2 },
    );

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const loaded = await rdb(ctx).load(SessionId("v0-session"));
      expect(loaded.events.map((event) => event.type)).toEqual([
        "turn/start",
        "user/message",
        "step/start",
        "tool/ptc-dispatch-start",
        "tool/ptc-dispatch",
        "assistant/message",
        "step/end",
        "turn/end",
      ]);
      const user = loaded.events[1]!;
      expect(
        user.type === "user/message" &&
          (user.data.source as { plugin?: string }).plugin === "tools-ptc",
      ).toBe(true);
      expect(() =>
        Session.fromRestore(
          SessionId("v0-session"),
          loaded.events,
          loaded.meta,
          SessionLogOffset(loaded.inheritedEventCount),
          "detached",
        ),
      ).not.toThrow();
    } finally {
      await fiber.dispose();
    }
  });

  it("adopts a mixed-generation v0 session the migration chain refuses (header version normalized, stream filled)", async () => {
    const path = await freshDbPath();
    createV0SessionDatabase(path, [
      { id: "evt-0", type: "turn/start", data: '{"turn":1}', surfaceOp: null },
      {
        id: "evt-1",
        type: "user/message",
        data: '{"id":"u1","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}',
        surfaceOp: '"append"',
      },
      { id: "evt-2", type: "step/start", data: '{"turn":1,"step":1}', surfaceOp: null },
      {
        id: "evt-3",
        type: "permission/preset",
        data: '{"preset":"workspace-write","origin":"selection"}',
        surfaceOp: null,
      },
      {
        id: "evt-4",
        type: "assistant/message",
        data: '{"turn":1,"step":1,"message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}}}',
        surfaceOp: '"append"',
      },
      { id: "evt-5", type: "step/end", data: '{"turn":1,"step":1}', surfaceOp: null },
      {
        id: "evt-6",
        type: "turn/end",
        data: '{"turn":1,"reason":{"kind":"completed"}}',
        surfaceOp: null,
      },
    ]);

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const loaded = await rdb(ctx).load(SessionId("v0-session"));
      expect(loaded.meta.version).toBe(SESSION_FORMAT_VERSION);
      expect(loaded.events).toHaveLength(7);

      const assistant = loaded.events[4]!;
      expect(assistant.type === "assistant/message" && assistant.data.stream).toEqual([]);

      const preset = loaded.events[3]!;
      expect(preset.data).toEqual({ preset: "workspace-write", origin: "selection" });

      expect(() =>
        Session.fromRestore(
          SessionId("v0-session"),
          loaded.events,
          loaded.meta,
          SessionLogOffset(loaded.inheritedEventCount),
          "detached",
        ),
      ).not.toThrow();
    } finally {
      await fiber.dispose();
    }
  });

  it("still refuses an unknown legacy event type after the mixed-generation fallback", async () => {
    const path = await freshDbPath();
    createV0SessionDatabase(path, [
      { id: "evt-0", type: "turn/start", data: '{"turn":1}', surfaceOp: null },
      {
        id: "evt-1",
        type: "permission/preset",
        data: '{"preset":"workspace-write","origin":"selection"}',
        surfaceOp: null,
      },
      {
        id: "evt-2",
        type: "assistant/chunk",
        data: '{"turn":1,"step":1,"chunk":{}}',
        surfaceOp: null,
      },
    ]);

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      await expect(rdb(ctx).load(SessionId("v0-session"))).rejects.toThrow(
        /assistant\/chunk.*unknown to this harness/s,
      );
    } finally {
      await fiber.dispose();
    }
  });

  it("rewrites a migrated v0 log on write open so read and write coordinates agree", async () => {
    const path = await freshDbPath();

    createV0SessionDatabase(
      path,
      [
        { id: "evt-0", type: "turn/start", data: '{"turn":1}', surfaceOp: null },
        { id: "evt-1", type: "step/start", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-2",
          type: "user/message",
          data: '{"content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}',
          surfaceOp: '"append"',
        },
        {
          id: "evt-3",
          type: "assistant/message",
          data: '{"turn":1,"step":1,"content":[{"type":"text","text":"hello"}],"provenance":{"provider":"mock","model":"mock"}}',
          surfaceOp: '"append"',
        },
        { id: "evt-4", type: "step/end", data: '{"turn":1,"step":1}', surfaceOp: null },
        {
          id: "evt-5",
          type: "turn/end",
          data: '{"turn":1,"reason":{"kind":"completed"}}',
          surfaceOp: null,
        },
      ],
      { seedLength: 0 },
    );

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    try {
      const handle = await rdb(ctx).open(SessionId("v0-session"), "write");
      const read = await handle.read(0, undefined);
      expect(read.events).toHaveLength(8);
      await handle.append([{ type: "session/end-seed", seq: SessionSeq(8), time: 2000, data: {} }]);
      await handle.close();

      const db = new DatabaseSync(path, { readOnly: true });
      const session = db
        .prepare(
          "SELECT f_version, f_head_sequence FROM t_sessions WHERE f_session_id = 'v0-session'",
        )
        .get() as { f_version: number; f_head_sequence: number };
      expect(session).toEqual({ f_version: SESSION_FORMAT_VERSION, f_head_sequence: 8 });
      const { count } = db
        .prepare("SELECT COUNT(*) AS count FROM t_session_events WHERE f_session_id = 'v0-session'")
        .get() as { count: number };
      expect(count).toBe(9);
      db.close();

      const loaded = await rdb(ctx).load(SessionId("v0-session"));
      expect(loaded.meta.version).toBe(SESSION_FORMAT_VERSION);
      expect(loaded.events).toHaveLength(9);
    } finally {
      await fiber.dispose();
    }
  });
});

function createV0SessionDatabase(
  path: string,
  rows: ReadonlyArray<{ id: string; type: string; data: string; surfaceOp: string | null }>,
  options: { seedLength?: number; version?: number } = {},
): void {
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
    VALUES ('v0-session', '', ${rows.length - 1}, ${options.version ?? 0}, 1000, '/work', NULL, ${options.seedLength ?? null}, NULL, NULL, 'inc-0', 1);
  `);
  const insertEvent = db.prepare(
    `INSERT INTO t_events (f_event_id, f_parent_id, f_type, f_data, f_created_at)
     VALUES (?, '', ?, ?, ?)`,
  );
  const insertBridge = db.prepare(
    `INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence, f_original_seq, f_surface_op)
     VALUES ('v0-session', ?, ?, ?, ?)`,
  );
  rows.forEach((row, seq) => {
    insertEvent.run(row.id, row.type, row.data, 1000 + seq);
    insertBridge.run(row.id, seq, seq, row.surfaceOp);
  });
  db.close();
}
