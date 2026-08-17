/**
 * PostgreSQL backend contract tests against a real dev instance (compose).
 *
 * Isolation unit is a dedicated database per fixture (created/dropped through
 * an admin connection), so each contract case starts from a truly empty store —
 * the same "fresh, empty backend" guarantee the SQLite spec gets from `:memory:`
 * / a temp file. The suite skips unless `TEST_PG_URL` is set; `just pg-test`
 * starts the compose service and points the variable at it.
 *
 * The PostgreSQL backend commits each append in ONE transaction (no SQLite
 * `BEGIN IMMEDIATE` / busy-timeout torn-tail window), so it structurally cannot
 * produce a torn tail — the coordinator contract's torn-tail case therefore
 * asserts `corruptTail` is absent rather than injecting one.
 * @module @morlay/session-rdb/tests/pg
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { Client } from "pg";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { EmptySettings } from "./testing/helpers.ts";
import SessionPersistenceRdb from "../index.ts";
import { runPersistenceContract } from "./testing/contract.ts";
import { runCoordinatorContract, type CoordinatorFixture } from "./testing/coordinator-contract.ts";

/** Admin connection string — the `postgres` database, used to create/drop test databases. */
const ADMIN_URL =
  process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:25433/postgres";

/** A dedicated empty database for one contract case/fixture, plus its teardown. */
async function createTestDatabase(): Promise<{
  connectionString: string;
  drop: () => Promise<void>;
}> {
  const name = `dsh_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return {
    connectionString: url.toString(),
    drop: async () => {
      // FORCE severs any residual connection (e.g. a fiber the contract case
      // disposed only via ctx.fiber.dispose) before the database can be dropped.
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

describe.skipIf(!process.env.TEST_PG_URL)("PostgreSQL backend", () => {
  runPersistenceContract("postgres", async () => {
    const { connectionString, drop } = await createTestDatabase();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceRdb, {
      type: "postgres",
      connectionString,
    });
    return {
      persistence: ctx.sessionPersistence,
      dispose: async () => {
        await fiber.dispose();
        await drop();
      },
    };
  });

  runCoordinatorContract("postgres", async (): Promise<CoordinatorFixture> => {
    const { connectionString, drop } = await createTestDatabase();
    return {
      mount: async (ctx: Context) => {
        if (ctx.reflect.get("settings") === undefined) {
          await ctx.plugin(EmptySettings);
        }
        return await ctx.plugin(SessionPersistenceRdb, { type: "postgres", connectionString });
      },
      // No corruptTail: PG appends are single-transaction (atomic commit), so a
      // never-committed tail cannot exist — the torn-tail case asserts this.
      cleanup: async () => {
        await drop();
      },
    };
  });
});
