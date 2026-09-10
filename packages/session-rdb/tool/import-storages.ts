/**
 * 显式导入命令：把 `$DSH_HOME/storages` 的旧 JSON 数据导入 session-rdb 的
 * 语义专用表。用法（先停掉 dsh，避免与运行中的库竞争）：
 *
 *   pnpm exec tsx packages/session-rdb/tool/import-storages.ts \
 *     --dsh-home apps/dsh-custom-next/.dsh-store \
 *     --path apps/dsh-custom-next/.dsh-store/sessions/sessions.sqlite
 *
 * PostgreSQL：`--type postgres --connection-string postgres://... [--schema public]`。
 */

import { parseArgs } from "node:util";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { importStorages } from "../src/import-storages.ts";
import { PostgresBackend } from "../src/postgres.ts";
import { SqliteBackend } from "../src/sqlite.ts";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/schema.ts";

function usage(message: string): never {
  console.error(message);
  console.error(
    "usage: import-storages --dsh-home <dir> [--type sqlite --path <db> | --type postgres --connection-string <dsn> [--schema <name>]]",
  );
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    "dsh-home": { type: "string" },
    type: { type: "string", default: "sqlite" },
    path: { type: "string" },
    "connection-string": { type: "string" },
    schema: { type: "string" },
  },
});

const dshHome = values["dsh-home"];
if (dshHome === undefined) usage("missing --dsh-home");

const backend =
  values.type === "sqlite"
    ? values.path === undefined
      ? usage("missing --path for sqlite")
      : new SqliteBackend({
          path: values.path,
          journalMode: "wal",
          busyTimeout: DEFAULT_BUSY_TIMEOUT_MS,
        })
    : values["connection-string"] === undefined
      ? usage("missing --connection-string for postgres")
      : (() => {
          const pool = new Pool({ connectionString: values["connection-string"] });
          pool.on("error", () => {});
          return new PostgresBackend(drizzlePg({ client: pool }), {
            identityBase: `postgres:${pool.options.host ?? "localhost"}:${String(pool.options.port ?? 5432)}:${pool.options.database ?? ""}:${values.schema ?? "public"}`,
            schema: values.schema ?? "public",
            close: () => pool.end(),
          });
        })();

await backend.open();
try {
  const result = await importStorages(backend.storage, { dshHome });
  console.log(
    `imported: workspaces=${String(result.workspaces)} ` +
      `workspaceState=${String(result.workspaceState)} projcache=${String(result.projcache)}`,
  );
} finally {
  await backend.close();
}
