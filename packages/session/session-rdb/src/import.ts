import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { SESSION_FORMAT_VERSION, SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent, SessionId, SessionHeader } from "@deepseek-ai/dsh-session";
import { parseSessionFormatLogFilename } from "@deepseek-ai/dsh-session-format";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import { balanceRewindPrefix } from "@morlay/session-branch";
import { unzip } from "fflate";
import { replaceLiveSessionLog } from "./branch.ts";
import type { SessionPersistenceRdb } from "./index.ts";

export const SESSION_LOG_ARTIFACT_FILENAME = "session.jsonl";

export const SESSION_IMPORT_PATH = "/api/session.import";

const MAX_IMPORT_ZIP_BYTES = 64 * 1024 * 1024;

export function parseJsonlArtifact(content: string): SessionStorageMetadata & {
  events: SessionEvent[];
} {
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0] === "") {
    throw new Error("imported session log is empty");
  }
  let header: unknown;
  try {
    header = JSON.parse(lines[0] as string) as unknown;
  } catch {
    throw new Error("imported session log has an unparsable header line");
  }

  let restore: ReturnType<typeof sessionFormatCatalog.createRestore>;
  try {
    restore = sessionFormatCatalog.createRestore(header, {
      recovery: "strict",
      validation: "transformed",
    });
  } catch (error: unknown) {
    throw new Error(
      `imported session log has an invalid header line: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`imported session log has an unparsable event line at ${i}`);
    }
    try {
      restore.decodeRow(parsed);
    } catch (error: unknown) {
      throw new Error(
        `imported session log has an invalid event line at ${i}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let artifact: { header: unknown; inheritedEventCount: number; events: readonly unknown[] };
  try {
    artifact = restore.finish() as unknown as {
      header: unknown;
      inheritedEventCount: number;
      events: readonly unknown[];
    };
  } catch (error: unknown) {
    throw new Error(
      `imported session log is incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const meta = artifact.header as SessionHeader;
  const events = artifact.events as SessionEvent[];

  for (let i = 0; i < events.length; i++) {
    if (events[i]!.seq !== i) {
      throw new Error(
        `imported session log seq gap at ${i} (got ${events[i]!.seq}); import requires a dense log`,
      );
    }
  }

  const inheritedEventCount = Math.min(artifact.inheritedEventCount, events.length);
  return {
    meta: {
      version: SESSION_FORMAT_VERSION,
      id: meta.id,
      createdAt: meta.createdAt,
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
      ...(meta.parentSession === undefined ? {} : { parentSession: meta.parentSession }),
      isSeeded: meta.isSeeded,
      ...(meta.origin === undefined ? {} : { origin: meta.origin }),
      ...(meta.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth }),
      ...(meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }),
    },
    inheritedEventCount: SessionLogOffset(inheritedEventCount),
    events,
  };
}

/**
 * fflate 的 `unzip` 是回调式异步 API（node 侧内部走 worker_threads，浏览器侧走 Web Worker），
 * 这里桥成 Promise。它与 `unzipSync` 的差异只在同步/异步：非法 zip 走的是同一段校验代码，
 * 拒绝的错误对象与同步版一致，因此上层文案无需区分。
 */
function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, entries) => {
      if (error === null) resolve(entries);
      else reject(error);
    });
  });
}

export async function parseImportZip(
  zip: Uint8Array,
): Promise<SessionStorageMetadata & { events: SessionEvent[] }> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipAsync(zip);
  } catch {
    throw new Error("imported zip is not a valid ZIP archive");
  }

  const artifact = Object.entries(entries).find(
    ([name]) => parseSessionFormatLogFilename(name) !== undefined,
  );
  if (artifact === undefined) {
    throw new Error(
      `imported zip has no session log artifact (expected ${SESSION_LOG_ARTIFACT_FILENAME} ` +
        "or a canonical session.vN.jsonl)",
    );
  }
  return parseJsonlArtifact(new TextDecoder().decode(artifact[1]));
}

interface ImportAgentLike {
  cancel?(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

async function stopAgentLoop(ctx: Context, sessionId: SessionId): Promise<void> {
  const agents = ctx.get("agents") as
    | { get(id: SessionId): ImportAgentLike | undefined }
    | undefined;
  const agent = agents?.get(sessionId);
  if (agent === undefined) return;
  agent.cancel?.({ kind: "user" }, { keepInbox: true });
  await agent.whenIdle();
}

export async function persistImport(
  persistence: SessionPersistenceRdb,
  branch:
    | {
        rewind(id: SessionId, toBoundary: number): Promise<unknown>;

        resetLiveDerivedState?(session: Session): void;
      }
    | undefined,
  imported: SessionStorageMetadata & { events: SessionEvent[] },
  targetId?: SessionId,
  sessions?: { get(id: SessionId): Session | undefined },
  stopLoop?: (id: SessionId) => Promise<void>,
): Promise<SessionId> {
  const id = targetId ?? (`session-${randomUUID()}` as SessionId);
  // 整段导入的日志先配平：已不平衡的尾部会让接收会话的 token-meter 折叠在续写时报 step/end 无配对。
  // 尾部未闭合的 step 是中断运行的正常形状，由上游 resume 补 closers，保持原样。
  const events = balanceRewindPrefix(imported.events, { keepOpenTail: true });
  if (targetId !== undefined) {
    if (branch === undefined) {
      throw new Error("sessionBranch service is unavailable");
    }

    if (stopLoop !== undefined) await stopLoop(targetId);
    await branch.rewind(targetId, -1);

    const liveHandle = persistence.tracker.writerOf(targetId);
    if (liveHandle !== undefined) {
      if (events.length > 0) await liveHandle.append(events);
    } else {
      const handle = await persistence.open(targetId, "write");
      try {
        if (events.length > 0) await handle.append(events);
      } finally {
        await handle.close();
      }
    }
  } else {
    const handle = await persistence.create(
      { ...imported.meta, id },
      {
        inheritedEventCount: SessionLogOffset(
          Math.min(imported.inheritedEventCount, events.length),
        ),
      },
    );
    if (events.length > 0) await handle.append(events);
    await handle.close();
  }

  if (targetId !== undefined) {
    const live = sessions?.get(targetId);
    if (live !== undefined) {
      replaceLiveSessionLog(live, events);
      branch?.resetLiveDerivedState?.(live);
    }
  }
  return id;
}

export function registerSessionImport(ctx: Context, persistence: SessionPersistenceRdb): void {
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
          path: SESSION_IMPORT_PATH,
          handler: async (req, res) => {
            const rejection = connection.requestRejection(req);
            if (rejection !== undefined) {
              res.writeHead(rejection);
              res.end(rejection === 401 ? "unauthorized" : "forbidden");
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const body = Buffer.concat(chunks);
            let envelope: { zip?: unknown; sessionId?: unknown };
            try {
              envelope = JSON.parse(body.toString("utf8")) as {
                zip?: unknown;
                sessionId?: unknown;
              };
            } catch {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "request body is not JSON" }));
              return;
            }
            if (typeof envelope.zip !== "string" || envelope.zip === "") {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "missing zip field" }));
              return;
            }
            if (
              envelope.sessionId !== undefined &&
              (typeof envelope.sessionId !== "string" || envelope.sessionId === "")
            ) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "sessionId must be a non-empty string" }));
              return;
            }
            let zip: Uint8Array;
            try {
              zip = Buffer.from(envelope.zip, "base64");
            } catch {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "zip field is not valid base64" }));
              return;
            }
            if (zip.byteLength > MAX_IMPORT_ZIP_BYTES) {
              res.writeHead(413, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "imported zip exceeds the size limit" }));
              return;
            }
            let imported: SessionStorageMetadata & { events: SessionEvent[] };
            try {
              imported = await parseImportZip(zip);
            } catch (error: unknown) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "imported zip is invalid",
                }),
              );
              return;
            }
            const targetId =
              typeof envelope.sessionId === "string"
                ? (envelope.sessionId as SessionId)
                : undefined;
            const branch = webCtx.get("sessionBranch") as unknown as
              | {
                  rewind(id: SessionId, toBoundary: number): Promise<unknown>;
                  resetLiveDerivedState?(session: Session): void;
                }
              | undefined;
            try {
              const sessions = webCtx.get("sessions") as
                | { get(id: SessionId): Session | undefined }
                | undefined;
              const id = await persistImport(
                persistence,
                branch,
                imported,
                targetId,
                sessions,
                (sessionId) => stopAgentLoop(webCtx, sessionId),
              );
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ sessionId: id }));
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              if (targetId !== undefined && /not found/i.test(message)) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: `session "${targetId}" not found` }));
                return;
              }
              res.writeHead(500, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "import failed",
                }),
              );
              return;
            }
          },
        }),
      `session-rdb: ${SESSION_IMPORT_PATH} route`,
    );
  });
}
