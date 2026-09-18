import type { SessionId } from "@deepseek-ai/dsh-session";

/** host 侧已存在的会话路由。 */
export const SESSION_DELETE_PATH = "/api/session.delete";
export const SESSION_IMPORT_PATH = "/api/session.import";
export const SESSION_EXPORT_PATH = "/api/session.export";
export const SESSION_GC_PATH = "/api/session.gc";

/** 页面之外的服务面：归档状态与列表刷新都归它们的既有 owner。 */
export interface ConversationManagerPorts {
  archiveSession(sessionId: SessionId): Promise<void>;
  unarchiveSession(sessionId: SessionId): Promise<void>;
  refresh(): Promise<void>;
}

/** GC 一次执行的回报。 */
export interface ConversationManagerGcResult {
  orphanSessions: number;
  orphanEvents: number;
  stoppedAgents: number;
}

/** 页面从注入面拿到的动作（属性语法：页面解构后直接调用，不绑 this）。 */
export interface ConversationManagerFace {
  archive: (sessionId: SessionId) => Promise<void>;
  unarchive: (sessionId: SessionId) => Promise<void>;
  remove: (sessionId: SessionId) => Promise<void>;
  exportZip: (sessionId: SessionId) => Promise<void>;
  importZip: (file: File) => Promise<SessionId>;
  collectGarbage: () => Promise<ConversationManagerGcResult>;
}

/** 带 host 错误码的请求失败：页面据此选本地化文案。 */
export class ConversationManagerRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ConversationManagerRequestError";
  }
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    code?: unknown;
  };
  if (!response.ok) {
    throw new ConversationManagerRequestError(
      typeof value.error === "string" ? value.error : `请求失败：HTTP ${response.status}`,
      typeof value.code === "string" ? value.code : undefined,
    );
  }
  return value;
}

async function zipBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("failed to read the selected file"));
    };
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? dataUrl : dataUrl.slice(comma + 1);
}

/** 页面的动作：host 交互收在这里，页面只见数据与回调。 */
export class ConversationManagerController {
  readonly face: ConversationManagerFace;

  constructor(private readonly ports: ConversationManagerPorts) {
    this.face = {
      archive: (sessionId) => this.ports.archiveSession(sessionId),
      unarchive: (sessionId) => this.ports.unarchiveSession(sessionId),
      remove: (sessionId) => this.remove(sessionId),
      exportZip: (sessionId) => this.exportZip(sessionId),
      importZip: (file) => this.importZip(file),
      collectGarbage: () => this.collectGarbage(),
    };
  }

  private async remove(sessionId: SessionId): Promise<void> {
    await postJson(SESSION_DELETE_PATH, { sessionId });
    await this.ports.refresh();
  }

  private async exportZip(sessionId: SessionId): Promise<void> {
    const response = await fetch(SESSION_EXPORT_PATH, {
      method: "POST",
      headers: { accept: "application/zip", "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        code?: unknown;
      };
      throw new ConversationManagerRequestError(
        typeof value.error === "string" ? value.error : `请求失败：HTTP ${response.status}`,
        typeof value.code === "string" ? value.code : undefined,
      );
    }
    downloadBlob(
      await response.blob(),
      filenameOf(response.headers.get("content-disposition"), String(sessionId)),
    );
  }

  private async importZip(file: File): Promise<SessionId> {
    const zip = await zipBase64(file);
    const value = await postJson(SESSION_IMPORT_PATH, { zip });
    await this.ports.refresh();
    return value["sessionId"] as SessionId;
  }

  private async collectGarbage(): Promise<ConversationManagerGcResult> {
    const value = await postJson(SESSION_GC_PATH, {});
    await this.ports.refresh();
    return {
      orphanSessions: typeof value["orphanSessions"] === "number" ? value["orphanSessions"] : 0,
      orphanEvents: typeof value["orphanEvents"] === "number" ? value["orphanEvents"] : 0,
      stoppedAgents: typeof value["stoppedAgents"] === "number" ? value["stoppedAgents"] : 0,
    };
  }
}

/** 导出文件名优先取 host 给的 Content-Disposition。 */
function filenameOf(disposition: string | null, sessionId: string): string {
  const matched = disposition === null ? null : /filename="([^"]+)"/u.exec(disposition);
  return matched?.[1] ?? `${sessionId}.zip`;
}

/** 浏览器下载：blob URL + 一次性 anchor；URL 在下一轮事件循环回收。 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
