import type { Context } from "@deepseek-ai/cordis";
import type { SessionPersistenceRdb } from "./index.ts";

export const SESSION_GC_PATH = "/api/session.gc";

interface GcAgentLike {
  cancel?(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

/** 让所有运行中的 agent 先退场：GC 要重写事件表，运行中的写路径必须停下来。 */
async function stopRunningAgents(ctx: Context): Promise<number> {
  const agents = ctx.get("agents") as { list(): GcAgentLike[] } | undefined;
  const running = agents?.list() ?? [];
  for (const agent of running) agent.cancel?.({ kind: "user" }, { keepInbox: true });
  await Promise.all(running.map((agent) => agent.whenIdle()));
  return running.length;
}

/** GC 通道：停 agent → 回收孤儿事件行 → VACUUM，一次请求完成。 */
export function registerSessionGc(ctx: Context, persistence: SessionPersistenceRdb): void {
  ctx.inject(["webServer", "connection"] as const, (webCtx) => {
    const webServer = webCtx.webServer as unknown as {
      register(route: {
        kind: "exact";
        path: string;
        handler: (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse,
        ) => void | Promise<void>;
      }): () => void;
    };
    const connection = webCtx.get("connection") as unknown as {
      requestRejection(request: {
        headers: import("node:http").IncomingHttpHeaders;
      }): number | undefined;
    };
    return webCtx.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: SESSION_GC_PATH,
          handler: async (req, res) => {
            const rejection = connection.requestRejection(req);
            if (rejection !== undefined) {
              res.writeHead(rejection);
              res.end(rejection === 401 ? "unauthorized" : "forbidden");
              return;
            }
            if (req.method !== "POST") {
              res.writeHead(405, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "method not allowed" }));
              return;
            }
            try {
              const stoppedAgents = await stopRunningAgents(webCtx);
              // 先回收孤儿会话，再回收事件行：被删会话独占的事件行才刚成为孤儿。
              const orphanSessions = await persistence.collectOrphanSessions();
              const orphanEvents = await persistence.collectOrphans();
              await persistence.vacuum();
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({ orphanSessions, orphanEvents, stoppedAgents, vacuumed: true }),
              );
            } catch (error: unknown) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(
                JSON.stringify({ error: error instanceof Error ? error.message : "gc failed" }),
              );
            }
          },
        }),
      `session-rdb: ${SESSION_GC_PATH} route`,
    );
  });
}
