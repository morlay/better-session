import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { Client } from "pg";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { EmptySettings } from "@morlay/session-rdb/testing";
import SessionPersistenceRdb from "@morlay/session-rdb";
import { runPersistenceContract } from "@morlay/session-rdb/testing";
import { runCoordinatorContract, type CoordinatorFixture } from "@morlay/session-rdb/testing";

const ADMIN_URL =
  process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:25433/postgres";

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
