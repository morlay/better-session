/**
 * Cross-process busy-timeout contract: while one connection holds the write
 * lock, a second process's write either fails immediately (`busyTimeout: 0`,
 * SQLite's default — the session tail of the second `dsh` instance is silently
 * lost) or waits and succeeds (the default 5000ms — contention becomes a
 * queue). This is the durability guarantee behind the `busyTimeout` config:
 * two instances sharing one `sessions.sqlite` must never lose an append to a
 * momentary lock collision.
 *
 * The lock holder and the waiter are separate processes (a synchronous
 * `BEGIN IMMEDIATE` in the same process would block the event loop and could
 * never release the lock). The waiter script uses only `node:sqlite`, so it
 * runs from a plain temp file without the repository's module graph.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../sqlite.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-busy-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

/** One child process: try `BEGIN IMMEDIATE` with a given busy timeout, report the outcome. */
function tryWriteLock(
  path: string,
  busyTimeout: number,
): Promise<{ ok: boolean; waitedMs?: number; error?: string }> {
  const script = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(path)})
    db.exec('PRAGMA busy_timeout = ' + ${busyTimeout})
    const t0 = Date.now()
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec('COMMIT')
      console.log('RESULT ' + JSON.stringify({ ok: true, waitedMs: Date.now() - t0 }))
    } catch (e) {
      console.log('RESULT ' + JSON.stringify({ ok: false, error: String(e) }))
    }
    process.exit(0)
  `;
  return writeFile(join(dirname(path), "waiter.cjs"), script).then(
    () =>
      new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [join(dirname(path), "waiter.cjs")], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
          out += d;
        });
        child.stderr.on("data", (d) => {
          err += d;
        });
        child.on("close", (code) => {
          const line = out.split("\n").find((l) => l.startsWith("RESULT "));
          if (line) {
            resolvePromise(JSON.parse(line.slice("RESULT ".length)));
          } else {
            resolvePromise({ ok: false, error: `child exited ${code}: ${err}` });
          }
        });
      }),
  );
}

describe("busyTimeout: cross-process write-lock contention", () => {
  it("a zero timeout fails immediately while the lock is held (SQLite default would lose the append)", async () => {
    const path = await freshDbPath();
    const holder = openDatabase(path, "wal", 0);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const result = await tryWriteLock(path, 0);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/database is locked|busy/i);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("a nonzero timeout waits for the lock and commits (contention becomes a queue, not a loss)", async () => {
    const path = await freshDbPath();
    const holder = openDatabase(path, "wal", 0);
    holder.exec("BEGIN IMMEDIATE");
    // Release the lock shortly after the waiter has begun contending on it.
    const release = setTimeout(() => {
      holder.exec("COMMIT");
    }, 800);
    try {
      const result = await tryWriteLock(path, 5000);
      expect(result.ok).toBe(true);
      expect(result.waitedMs).toBeGreaterThanOrEqual(400);
    } finally {
      clearTimeout(release);
      holder.close();
    }
  });
});
