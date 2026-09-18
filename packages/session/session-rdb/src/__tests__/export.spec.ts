// 导出通道闭环：POST /api/session.export 直接把会话日志打成 zip 响应体
// （与导入通道对称——同一份 artifact 能被 parseJsonlArtifact 读回）。
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { unzip } from "fflate";
import { parseSessionFormatLogFilename } from "@deepseek-ai/dsh-session-format";
import SessionPersistenceRdb from "@morlay/session-rdb";
import { SESSION_EXPORT_PATH } from "@morlay/session-rdb/export";
import { EmptySettings, meta, oneTurnLog } from "@morlay/session-rdb/testing";
import { parseJsonlArtifact } from "../import.ts";

/** fflate 只给回调式异步 API（同步变体被 node/no-sync 禁止）。 */
function unzipBytes(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, data) => {
      if (error === null) resolve(data);
      else reject(error);
    });
  });
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function harness(): Promise<{ ctx: Context; persistence: SessionPersistenceRdb }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  new SessionProjectionRegistry(ctx);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path: ":memory:" });
  disposers.push(() => fiber.dispose());
  return { ctx, persistence: ctx.sessionPersistence as SessionPersistenceRdb };
}

async function createPersisted(
  ctx: Context,
  id: string,
  events: readonly SessionEvent[] = oneTurnLog(),
  header: SessionHeader = meta(id),
): Promise<void> {
  const handle = await ctx.sessionPersistence.create(header);
  try {
    await handle.append([...events]);
  } finally {
    await handle.close();
  }
}

interface Response {
  res: import("node:http").ServerResponse;
  code: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

function fakeResponse(): Response {
  const state = {
    res: undefined as unknown as import("node:http").ServerResponse,
    code: 0,
    headers: {} as Record<string, string>,
    body: new Uint8Array(),
  };
  state.res = {
    writeHead: (code: number, headers?: Record<string, string>) => {
      state.code = code;
      Object.assign(state.headers, headers ?? {});
      return state.res;
    },
    end: (chunk?: Uint8Array | string) => {
      if (chunk !== undefined) {
        state.body =
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      }
    },
  } as unknown as import("node:http").ServerResponse;
  return state;
}

function fakeRequest(body: unknown): import("node:http").IncomingMessage {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield chunk;
    },
  } as unknown as import("node:http").IncomingMessage;
}

async function exportRoute(
  ctx: Context,
): Promise<(req: unknown, res: unknown) => void | Promise<void>> {
  const routes = new Map<string, (req: unknown, res: unknown) => void | Promise<void>>();
  ctx.provide("webServer", {
    register: (route: {
      path: string;
      handler: (req: unknown, res: unknown) => void | Promise<void>;
    }) => {
      routes.set(route.path, route.handler);
      return () => {};
    },
  });
  ctx.provide("connection", { requestRejection: () => undefined });
  for (let i = 0; i < 1000 && !routes.has(SESSION_EXPORT_PATH); i += 1) await Promise.resolve();
  const handler = routes.get(SESSION_EXPORT_PATH);
  if (handler === undefined) throw new Error("export route was not registered");
  return handler;
}

describe("导出通道", () => {
  it("把会话日志打成 zip 响应体，且能被导入侧的解析器读回", async () => {
    const { ctx } = await harness();
    await createPersisted(ctx, "keep-me");
    const handler = await exportRoute(ctx);

    const response = fakeResponse();
    await handler(fakeRequest({ sessionId: "keep-me" }), response.res);

    expect(response.code).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toContain('filename="keep-me.zip"');

    const entries = await unzipBytes(response.body);
    const artifact = Object.keys(entries).find(
      (name) => parseSessionFormatLogFilename(name) !== undefined,
    );
    expect(artifact).toBeDefined();
    const parsed = parseJsonlArtifact(new TextDecoder().decode(entries[artifact as string]));
    expect(String(parsed.meta.id)).toBe("keep-me");
    expect(parsed.events.length).toBeGreaterThan(0);
  });

  it("未知会话返回 404", async () => {
    const { ctx } = await harness();
    const handler = await exportRoute(ctx);

    const response = fakeResponse();
    await handler(fakeRequest({ sessionId: "missing" }), response.res);
    expect(response.code).toBe(404);
  });

  it("缺 sessionId 返回 400", async () => {
    const { ctx } = await harness();
    const handler = await exportRoute(ctx);

    const response = fakeResponse();
    await handler(fakeRequest({}), response.res);
    expect(response.code).toBe(400);
  });
});
