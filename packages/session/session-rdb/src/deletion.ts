// 会话删除端点：web 模式下 client 经 `/api/session.delete` 触发 host 侧的
// 已归档会话硬删除（上游没有会话删除面，见 ADR）。
//
// 鉴权与拒审复用 connection 的 `requestRejection`，与 `/api/session.import`
// 同一条通路；webServer / connection 由其他插件注册，本后端构造早于它们，
// 因此用 ctx.inject 延迟到两个服务就绪后再注册 exact route。

import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { SessionDeletionError, type SessionPersistenceRdb } from "./index.ts";

export const SESSION_DELETE_PATH = "/api/session.delete";

/** 删除失败到 HTTP 状态的映射（其余按 400 处理）。 */
const STATUS_OF_DELETION_ERROR: Record<SessionDeletionError["code"], number> = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ARCHIVED: 409,
  SESSION_LIVE: 409,
};

export function registerSessionDeletion(ctx: Context, persistence: SessionPersistenceRdb): void {
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
    return webCtx.effect(() =>
      webServer.register({
        kind: "exact",
        path: SESSION_DELETE_PATH,
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
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          let envelope: { sessionId?: unknown };
          try {
            envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              sessionId?: unknown;
            };
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "request body is not JSON" }));
            return;
          }
          if (typeof envelope.sessionId !== "string" || envelope.sessionId === "") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "missing sessionId field" }));
            return;
          }
          try {
            await persistence.deleteSession(envelope.sessionId as SessionId);
          } catch (error: unknown) {
            if (error instanceof SessionDeletionError) {
              res.writeHead(STATUS_OF_DELETION_ERROR[error.code], {
                "content-type": "application/json",
              });
              res.end(JSON.stringify({ error: error.message, code: error.code }));
              return;
            }
            res.writeHead(500, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : "session deletion failed",
              }),
            );
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ deleted: envelope.sessionId }));
        },
      }),
    );
  });
}
