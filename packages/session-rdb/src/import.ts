import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { SessionLogOffset, decodeSeqRanges, decodeStorageRecord } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import { unzipSync } from "fflate";
import { replaceLiveSessionLog } from "./branch.ts";
import type { SessionPersistenceRdb } from "./index.ts";

export const SESSION_LOG_ARTIFACT_FILENAME = "session.jsonl";

export const SESSION_IMPORT_PATH = "/api/session.import";

const MAX_IMPORT_ZIP_BYTES = 64 * 1024 * 1024;

export function expandProvenanceFromStorage(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("imported session records must be objects");
  }
  const record = parsed as { seq?: unknown; sourceEventSeqs?: unknown };
  if (record.sourceEventSeqs === undefined) return parsed;
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 0) {
    throw new TypeError("imported session event seq must be a non-negative safe integer");
  }
  return {
    ...record,
    sourceEventSeqs: decodeSeqRanges(record.sourceEventSeqs, (record.seq as number) + 1),
  };
}

export function parseJsonlArtifact(content: string): SessionStorageMetadata & {
  events: SessionEvent[];
} {
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0] === "") {
    throw new Error("imported session log is empty");
  }
  let header: Record<string, unknown> | undefined;
  try {
    header = JSON.parse(lines[0] as string) as Record<string, unknown>;
  } catch {
    throw new Error("imported session log has an unparsable header line");
  }
  if (
    typeof header !== "object" ||
    header === null ||
    header["type"] !== "session" ||
    typeof header["id"] !== "string" ||
    typeof header["version"] !== "number" ||
    !Number.isSafeInteger(header["createdAt"] as number) ||
    (header["createdAt"] as number) < 0
  ) {
    throw new Error("imported session log has an invalid header line");
  }
  const seedLength = header["seedLength"];
  if (
    seedLength !== undefined &&
    (!Number.isSafeInteger(seedLength) || (seedLength as number) < 0)
  ) {
    throw new Error("imported session log has an invalid seedLength");
  }
  const events: SessionEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`imported session log has an unparsable event line at ${i}`);
    }
    for (const event of decodeStorageRecord(expandProvenanceFromStorage(parsed))) {
      events.push(event);
    }
  }
  // 连续性校验：导入的 log 必须是从 0 开始的稠密 seq（落库前的最后一道闸）。
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.seq !== i) {
      throw new Error(
        `imported session log seq gap at ${i} (got ${events[i]!.seq}); import requires a dense log`,
      );
    }
  }
  const origin = header["origin"];
  const delegationDepth = header["delegationDepth"];
  // 继承前缀长度不得超过事件总数（上游 load 判损坏）；导出已收缩，此处
  // 防御性收缩非自洽的 artifact。
  const inheritedEventCount = Math.min((seedLength as number | undefined) ?? 0, events.length);
  return {
    meta: {
      version: header["version"] as number,
      id: header["id"] as SessionId,
      createdAt: header["createdAt"] as number,
      ...(typeof header["cwd"] === "string" ? { cwd: header["cwd"] } : {}),
      ...(typeof header["parentSession"] === "string"
        ? { parentSession: header["parentSession"] as SessionId }
        : {}),
      isSeeded: seedLength !== undefined,
      ...(origin === "subagent" ? { origin: origin as "subagent" } : {}),
      ...(Number.isSafeInteger(delegationDepth as number) && (delegationDepth as number) > 0
        ? { delegationDepth: delegationDepth as number }
        : {}),
      ...(typeof header["agentPreset"] === "string" ? { agentPreset: header["agentPreset"] } : {}),
    },
    inheritedEventCount: SessionLogOffset(inheritedEventCount),
    events,
  };
}

export function parseImportZip(zip: Uint8Array): SessionStorageMetadata & {
  events: SessionEvent[];
} {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new Error("imported zip is not a valid ZIP archive");
  }
  const artifact = entries[SESSION_LOG_ARTIFACT_FILENAME];
  if (artifact === undefined) {
    throw new Error(`imported zip is missing ${SESSION_LOG_ARTIFACT_FILENAME}`);
  }
  return parseJsonlArtifact(new TextDecoder().decode(artifact));
}

export async function persistImport(
  persistence: SessionPersistenceRdb,
  branch: { rewind(id: SessionId, toBoundary: number): Promise<unknown> } | undefined,
  imported: SessionStorageMetadata & { events: SessionEvent[] },
  targetId?: SessionId,
  sessions?: { get(id: SessionId): Session | undefined },
): Promise<SessionId> {
  const id = targetId ?? (`session-${randomUUID()}` as SessionId);
  if (targetId !== undefined) {
    if (branch === undefined) {
      throw new Error("sessionBranch service is unavailable");
    }
    await branch.rewind(targetId, -1);
  } else {
    await persistence.create({ ...imported.meta, id }, imported.inheritedEventCount);
  }
  if (imported.events.length > 0) await persistence.append(id, imported.events);
  // 覆盖语义的 live 同步：rewind 截断的 live log 由同一批导入事件补回
  // （不发布、不落库），使 observeSession 的 live 快照与 DB 一致。
  if (targetId !== undefined) {
    const live = sessions?.get(targetId);
    if (live !== undefined) replaceLiveSessionLog(live, imported.events);
  }
  return id;
}

export function registerSessionImport(ctx: Context, persistence: SessionPersistenceRdb): void {
  // webServer / connection 由其他插件注册，本后端构造早于它们——用
  // ctx.inject 延迟到两个服务就绪后再注册 exact route（disposer 随 fiber
  // 卸载自动回滚）；服务缺失（headless 装配、纯后端测试）时注入永不触发。
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
              imported = parseImportZip(zip);
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
              | { rewind(id: SessionId, toBoundary: number): Promise<unknown> }
              | undefined;
            try {
              const sessions = webCtx.get("sessions") as
                | { get(id: SessionId): Session | undefined }
                | undefined;
              const id = await persistImport(persistence, branch, imported, targetId, sessions);
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
