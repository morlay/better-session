/**
 * v1 → v2 数据库迁移（手动入口；启动时已自动迁移，本脚本用于离线迁移）。
 *
 * 用法：`pnpm exec tsx packages/session-rdb/scripts/migrate-v1-to-v2.mts <db-path>`
 * 迁移前请备份数据库文件。已 v2 的库直接返回（no-op）。
 */
import { DatabaseSync } from "node:sqlite";
import { migrateSqliteV1ToV2 } from "../src/migrate.ts";

function fail(message: string): never {
  console.error(`migrate: ${message}`);
  process.exit(1);
}

function main(): void {
  const dbPath = process.argv[2];
  if (dbPath === undefined) fail("usage: migrate-v1-to-v2.mts <db-path>");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    const migrated = migrateSqliteV1ToV2(db);
    db.exec("COMMIT");
    console.log(
      migrated === 0
        ? "migrate: database already at v2, nothing to do"
        : `migrate: v1 → v2 done (${migrated} events)`,
    );
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 原始错误保留。
    }
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

main();
