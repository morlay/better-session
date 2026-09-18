// @vitest-environment jsdom
// 注入面闭环：页面拿到的三个动作都打在已确认的接缝上——取消归档委托 uiWorkspace，
// 删除打 POST /api/session.delete，导入打 POST /api/session.import（不带 sessionId = 新建会话）；
// 成功路径刷新会话列表，失败路径把 host 的错误码带出来且不刷新。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { ConversationManagerController } from "../client/controller.ts";
import type { ConversationManagerPorts } from "../client/controller.ts";

interface FetchCall {
  url: string;
  body: unknown;
}

function stubFetch(status: number, payload: unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return {
      ok: status < 400,
      status,
      json: async () => payload,
    } as unknown as Response;
  });
  return calls;
}

/** 一份最小的用量回报（与 host 的 ./usage 结构一致）。 */
const REPORT_PAYLOAD = {
  totals: {
    events: 2,
    inputTokens: 150,
    outputTokens: 15,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 165,
  },
  subagent: {
    events: 1,
    inputTokens: 50,
    outputTokens: 5,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 55,
  },
  human: {
    events: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 110,
  },
  buckets: [],
  sessions: [],
};

function bench(): {
  ports: ConversationManagerPorts & { archived: string[]; unarchived: string[]; refreshes: number };
  controller: ConversationManagerController;
} {
  const archived: string[] = [];
  const unarchived: string[] = [];
  let refreshes = 0;
  const ports = {
    archived,
    unarchived,
    get refreshes() {
      return refreshes;
    },
    archiveSession: async (sessionId: SessionId) => {
      archived.push(String(sessionId));
    },
    unarchiveSession: async (sessionId: SessionId) => {
      unarchived.push(String(sessionId));
    },
    refresh: async () => {
      refreshes += 1;
    },
  } as unknown as ConversationManagerPorts & {
    archived: string[];
    unarchived: string[];
    refreshes: number;
  };
  return { ports, controller: new ConversationManagerController(ports) };
}

/** 导出返回 zip 响应体（非 JSON），文件名来自 Content-Disposition。 */
function stubZipFetch(status: number, headers: Record<string, string>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return {
      ok: status < 400,
      status,
      headers: new Headers(headers),
      json: async () => ({}),
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" }),
    } as unknown as Response;
  });
  return calls;
}

/** 下载落点：一次 createObjectURL + 一次带 download 名的 anchor 点击。 */
function stubDownload(): { created: string[]; downloaded: string[] } {
  const created: string[] = [];
  const downloaded: string[] = [];
  const target = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  target.createObjectURL = () => {
    const url = `blob:mock-${created.length}`;
    created.push(url);
    return url;
  };
  target.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded.push(this.download);
  });
  return { created, downloaded };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const target = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  delete target.createObjectURL;
  delete target.revokeObjectURL;
});

describe("对话管理注入面", () => {
  it("取消归档委托给 uiWorkspace", async () => {
    const b = bench();
    await b.controller.face.unarchive("s1" as SessionId);
    expect(b.ports.unarchived).toEqual(["s1"]);
  });

  it("归档委托给 uiWorkspace", async () => {
    const b = bench();
    await b.controller.face.archive("s1" as SessionId);
    expect(b.ports.archived).toEqual(["s1"]);
  });

  it("删除已归档会话后刷新会话列表", async () => {
    const b = bench();
    const calls = stubFetch(200, { deleted: "s1" });
    await b.controller.face.remove("s1" as SessionId);
    expect(calls).toEqual([{ url: "/api/session.delete", body: { sessionId: "s1" } }]);
    expect(b.ports.refreshes).toBe(1);
  });

  it("删除失败时带出 host 错误码且不刷新", async () => {
    const b = bench();
    stubFetch(409, { error: "session is not archived", code: "SESSION_NOT_ARCHIVED" });
    await expect(b.controller.face.remove("s1" as SessionId)).rejects.toMatchObject({
      code: "SESSION_NOT_ARCHIVED",
    });
    expect(b.ports.refreshes).toBe(0);
  });

  it("导入 zip 新建会话并在导入后刷新", async () => {
    const b = bench();
    const calls = stubFetch(200, { sessionId: "session-imported" });
    const id = await b.controller.face.importZip(
      new File([new Uint8Array([1, 2, 3])], "session.zip", { type: "application/zip" }),
    );
    expect(String(id)).toBe("session-imported");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/session.import");
    expect(Object.keys(calls[0]?.body as object)).toEqual(["zip"]);
    expect(b.ports.refreshes).toBe(1);
  });

  it("导入失败时抛出且不刷新", async () => {
    const b = bench();
    stubFetch(400, { error: "imported zip is not a valid ZIP archive" });
    await expect(
      b.controller.face.importZip(new File([new Uint8Array([0])], "bad.zip")),
    ).rejects.toThrow("imported zip is not a valid ZIP archive");
    expect(b.ports.refreshes).toBe(0);
  });

  it("导出落到下载：请求打导出路由，拿到 zip 后触发浏览器下载", async () => {
    const b = bench();
    const calls = stubZipFetch(200, { "content-disposition": 'attachment; filename="s1.zip"' });
    const download = stubDownload();

    await b.controller.face.exportZip("s1" as SessionId);

    expect(calls).toEqual([{ url: "/api/session.export", body: { sessionId: "s1" } }]);
    expect(download.created).toHaveLength(1);
    expect(download.downloaded).toEqual(["s1.zip"]);
    expect(b.ports.refreshes).toBe(0);
  });

  it("导出失败时抛出", async () => {
    const b = bench();
    stubFetch(404, { error: 'session "gone" not found' });
    await expect(b.controller.face.exportZip("gone" as SessionId)).rejects.toThrow(
      'session "gone" not found',
    );
  });

  it("清理孤儿数据打 GC 路由并回报结果，随后刷新会话列表", async () => {
    const b = bench();
    const calls = stubFetch(200, { orphanSessions: 3, orphanEvents: 12, stoppedAgents: 2 });

    const result = await b.controller.face.collectGarbage();

    expect(calls).toEqual([{ url: "/api/session.gc", body: {} }]);
    expect(result).toEqual({ orphanSessions: 3, orphanEvents: 12, stoppedAgents: 2 });
    expect(b.ports.refreshes).toBe(1);
  });

  it("用量统计打 usage 路由并回传三份数据", async () => {
    const b = bench();
    const calls = stubFetch(200, REPORT_PAYLOAD);

    const report = await b.controller.face.loadUsage(null);

    expect(calls).toEqual([{ url: "/api/session.usage", body: { rangeDays: null } }]);
    expect(report.totals.totalTokens).toBe(165);
    expect(report.subagent.inputTokens).toBe(50);
    expect(b.ports.refreshes).toBe(0);
  });

  it("用量统计响应不可用时给出失败原因", async () => {
    const b = bench();
    stubFetch(200, { totals: {} });
    await expect(b.controller.face.loadUsage(null)).rejects.toThrow("用量统计响应不可用");
  });

  it("时间范围随请求带给 host", async () => {
    const b = bench();
    const calls = stubFetch(200, REPORT_PAYLOAD);
    await b.controller.face.loadUsage(7);
    expect(calls).toEqual([{ url: "/api/session.usage", body: { rangeDays: 7 } }]);
  });
});
