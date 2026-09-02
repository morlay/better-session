/**
 * Session 导入：把 `session.export` 产出的 zip（内含 `session.jsonl` raw
 * artifact）解析回会话并落库。与导出（`toJsonlArtifact` / `readRaw`）互为
 * 逆操作：header 行 + 每事件一行（chunk 打包行展开、`sourceEventSeqs`
 * 区间展开），坐标与上游 JSONL 后端物理布局一致。
 *
 * HTTP 端点 `/api/session.import`（webServer exact route）接收 POST JSON
 * 信封 `{ zip: <base64> }`，鉴权复用 connection 的请求拒绝策略；解压后
 * 以**新 id**（`session-<uuid>`）落库——导入永远不覆盖既有会话。
 *
 * @module @morlay/session-rdb/import
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { SessionLogOffset, decodeSeqRanges, decodeStorageRecord } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionStorageMetadata } from "@deepseek-ai/dsh-session-persistence";
import { unzipSync } from "fflate";
import { replaceLiveSessionLog } from "./branch.ts";
import type { SessionPersistenceRdb } from "./index.ts";

/** 导入 zip 内 raw artifact 的固定文件名（与导出 `readRaw` 一致）。 */
export const SESSION_LOG_ARTIFACT_FILENAME = "session.jsonl";

/** 导入端点路径（`/api` 前缀下与导出的 exact route 并列）。 */
export const SESSION_IMPORT_PATH = "/api/session.import";

/** POST 信封的 zip 字段上限（base64 展开前）。 */
const MAX_IMPORT_ZIP_BYTES = 64 * 1024 * 1024;

/**
 * 展开一行 JSONL 的 storage-form provenance：`sourceEventSeqs` 的区间数组
 * （`[start, end]` 对）还原为 `SessionSeq[]`。与上游 JSONL 后端的
 * `expandProvenanceFromStorage` 语义一致；无 `sourceEventSeqs` 的记录原样
 * 返回。
 * @param parsed - 一行 `JSON.parse` 结果。
 * @returns 展开后的记录。
 * @throws 记录不是对象、seq 非法或区间畸形时抛错（导入的损坏输入拒绝）。
 */
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

/**
 * 解析导入的 JSONL 文本：首行必须是 `type: 'session'` 的 header 记录
 * （`seedLength` 携带继承前缀长度），后续每行一个存储记录（chunk 打包行
 * 展开为多个 `assistant/chunk` 事件）。
 * @param content - JSONL 文本。
 * @returns 会话元数据（含继承前缀长度）与展开后的完整事件列表。
 * @throws 首行缺失/畸形、任一事件行损坏时抛错（整体拒绝，不落库）。
 */
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
  if (seedLength !== undefined && (!Number.isSafeInteger(seedLength) || (seedLength as number) < 0)) {
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
    inheritedEventCount: SessionLogOffset((seedLength as number | undefined) ?? 0),
    events,
  };
}

/**
 * 解压导入的 zip 并解析其 raw artifact。zip 内必须含 `session.jsonl`；
 * 其余条目（`subagents/*`、`media/*`）当前不导入。
 * @param zip - zip 字节。
 * @returns 解析出的会话元数据与事件。
 * @throws zip 损坏或缺失 artifact 时抛错。
 */
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

/**
 * 导入落库：把解析出的会话写入持久化后端。
 * - `targetId` 为 undefined → 以新 id（`session-<uuid>`）导入（`create` +
 *   `append`）；
 * - `targetId` 指定 → **覆盖**该会话：先 `rewind(-1)` 清空其事件 log
 *   （live/cold 两条路径的 coordinator 状态与内存 log 一并同步），再
 *   `append` 导入的事件（append 的 upsert 会刷新 header 列为导入值，id
 *   保留目标会话）。覆盖后若该会话仍 live，把导入事件**同步回 live 内存
 *   log**（`observeSession` 优先读 live 快照，不同步则 UI 刷新重读仍命中
 *   空/残缺数据）。用于「导入到当前会话」的覆盖语义。
 * @param persistence - RDB 持久化后端。
 * @param branch - sessionBranch 服务（覆盖路径需要 rewind；缺失抛错）。
 * @param imported - 解析出的会话元数据与事件。
 * @param targetId - 覆盖目标；省略则 mint 新 id。
 * @param sessions - 可选的 SessionStore（同步 live 内存用）。
 * @returns 实际落库的会话 id。
 * @throws 覆盖目标不存在（rewind 报 not found）或写入失败时抛错。
 */
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
  // 覆盖语义的 live 同步：rewind 截断的 live log 由 append 后的同一批事件
  // 补回（不发布、不落库），使 observeSession 的 live 快照与 DB 一致。
  if (targetId !== undefined) {
    const live = sessions?.get(targetId);
    if (live !== undefined) replaceLiveSessionLog(live, imported.events);
  }
  return id;
}

/**
 * 注册 `/api/session.import` POST exact route：解压 zip、解析 JSONL 并落库。
 * 信封 `{ zip: <base64>, sessionId?: <string> }`：
 * - 无 `sessionId` → 以新 id（`session-<uuid>`）导入；
 * - 有 `sessionId` → **覆盖**该会话：rewind 清空其事件 log 后追加导入的
 *   事件（header 元数据以导入的 zip 为准，id 保留目标会话），用于
 *   「导入到当前会话」的覆盖语义。
 * 鉴权复用 connection 的请求拒绝策略（与导出的 `/api` 前缀一致）。
 *
 * webServer / connection 服务缺失时（headless 装配、纯后端测试）跳过注册
 * ——导入端点仅 web 环境需要，服务就绪后仍可单独调用。
 * @param ctx - 宿主上下文。
 * @param persistence - RDB 持久化后端（写入路径）。
 * @returns 路由 disposer（未注册时为 no-op）。
 */
export function registerSessionImport(
  ctx: Context,
  persistence: SessionPersistenceRdb,
): void {
  // webServer / connection 由其他插件在 apply 时注册；本后端构造早于它们，
  // 用 ctx.inject 延迟到两个服务就绪后再注册 exact route（注入回调返回的
  // disposer 随 fiber 卸载自动回滚）。服务缺失（headless 装配、纯后端测试）
  // 时注入永不触发——导入端点仅 web 环境需要，解析/落库纯函数仍可单测。
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
