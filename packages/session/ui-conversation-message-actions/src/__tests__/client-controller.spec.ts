// @vitest-environment jsdom
// 浏览器半的门控闭环：编辑器动作经 `/session-editor` 打到 host，
// recall 把文本回填 composer；就地编辑后刷新走 resync + 投影截断；
// timeline 打开版本时导航到目标会话。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { SessionEditorController } from "../client/controller.ts";
import { SESSION_EDITOR_PATH } from "../shared.ts";

interface FetchCall {
  url: string;
  body: string | undefined;
}

function responseFor(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

function stubFetch(payloads: readonly unknown[]): FetchCall[] {
  const calls: FetchCall[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    return responseFor(payload);
  });
  return calls;
}

function stubFailure(status: number, payload: unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    return {
      ok: false,
      status,
      json: async () => payload,
    } as unknown as Response;
  });
  return calls;
}

interface FakeSessions {
  list: { subscribe: (listener: () => void) => () => void; getSnapshot: () => unknown };
  binding: (id: string) => unknown;
  scope: (id: string) => unknown;
}

function fakeSessions(ids: readonly string[] = ["s1"]): {
  sessions: FakeSessions;
  drafts: string[];
  resyncs: string[];
} {
  const drafts: string[] = [];
  const resyncs: string[] = [];
  const byId: Record<string, unknown> = {};
  for (const id of ids) byId[id] = {};
  const sessions: FakeSessions = {
    list: { subscribe: () => () => {}, getSnapshot: () => ({ byId }) },
    binding: () => ({
      session: {
        subscribe: () => () => {},
        getSnapshot: () => ({ openState: "open", removed: false, hasMore: false }),
        resync: async () => {
          resyncs.push("resync");
        },
        projections: {
          truncate: (lastSeq: number) => resyncs.push(`truncate(${lastSeq})`),
        },
      },
    }),
    scope: () => ({
      get: () => ({ input: { for: () => ({ restoreDraft: (d: string) => drafts.push(d) }) } }),
    }),
  };
  return { sessions, drafts, resyncs };
}

/** 导航归 ui-workspace：controller 只把目标交给 ctx.uiWorkspace.openSession。 */
const opened: string[] = [];
const fakeWorkspace = {
  openSession: (sessionId: string) => {
    opened.push(sessionId);
  },
};

function timelinePayload(
  id: string,
  messages: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    sessionId: id,
    messages,
    retryableTurns: [],
    versions: [],
    undoStack: [],
    redoSessionIds: [],
  };
}

function controllerWith(sessions: FakeSessions, id = "s1"): SessionEditorController {
  const ctx = { get: (name: string) => (name === "uiWorkspace" ? fakeWorkspace : sessions) };
  return new SessionEditorController(ctx as never, id as SessionId);
}

const userBlock = {
  key: "4:0",
  turn: 1,
  eventSeq: 4,
  blockIndex: 0,
  kind: "user",
  text: "hello",
  time: 4,
} as never;

function mutateCalls(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.body !== undefined);
}

beforeEach(() => {
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__;
  opened.length = 0;
});

describe("SessionEditorController（浏览器半）", () => {
  it("load 把 timeline 装进状态；宿主内嵌时走 /api 前缀的连接路由", async () => {
    (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = { ownsHost: true };
    const { sessions } = fakeSessions();
    const controller = controllerWith(sessions);
    const calls = stubFetch([timelinePayload("s1", [{ ...(userBlock as object) }])]);

    await controller.load();

    expect(calls[0]?.url).toBe(`/api${SESSION_EDITOR_PATH}?sessionId=s1`);
    expect(controller.store.getSnapshot()).toMatchObject({
      status: "ready",
      error: null,
      timeline: { sessionId: "s1" },
    });
  });

  it("load 失败把错误留在状态里（不抛）", async () => {
    const { sessions } = fakeSessions();
    const controller = controllerWith(sessions);
    stubFailure(409, { error: "会话不存在" });

    await controller.load();

    expect(controller.store.getSnapshot()).toMatchObject({ status: "error", error: "会话不存在" });
  });

  it("recall 把撤回的文本回填到 composer，并只发一次 recall 请求", async () => {
    const { sessions, drafts } = fakeSessions();
    const controller = controllerWith(sessions);
    stubFetch([timelinePayload("s1", [{ ...(userBlock as object) }])]);
    await controller.load();

    const calls = stubFetch([{ sessionId: "s1", queuedTurns: 0 }, timelinePayload("s1")]);
    const applied = await controller.face.recall(userBlock);

    expect(applied).toBe(true);
    const posts = mutateCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(SESSION_EDITOR_PATH);
    expect(JSON.parse(posts[0]!.body!)).toEqual({
      action: "recall",
      sessionId: "s1",
      eventSeq: 4,
    });
    expect(drafts).toEqual(["hello"]);
  });

  it("就地编辑成功后走 resync 并丢弃投影行（旧 seq 不得残留）", async () => {
    const { sessions, resyncs } = fakeSessions();
    const controller = controllerWith(sessions);
    const calls = stubFetch([
      { sessionId: "s1", queuedTurns: 1, live: true },
      timelinePayload("s1"),
    ]);

    const applied = await controller.face.edit(userBlock, "edited", "truncate");

    expect(applied).toBe(true);
    expect(JSON.parse(mutateCalls(calls)[0]!.body!)).toEqual({
      action: "edit",
      sessionId: "s1",
      eventSeq: 4,
      blockIndex: 0,
      text: "edited",
      cascade: "truncate",
    });
    expect(resyncs).toEqual(["resync", "truncate(-1)"]);
  });

  it("timeline 打开另一版本经 ui-workspace 导航过去", async () => {
    const { sessions } = fakeSessions(["s1", "child"]);
    const controller = controllerWith(sessions);

    await controller.face.openVersion("child");

    expect(opened).toEqual(["child"]);
  });

  it("失败响应把错误留在状态里且不阻塞下一次操作", async () => {
    const { sessions } = fakeSessions();
    const controller = controllerWith(sessions);
    stubFetch([timelinePayload("s1")]);
    await controller.load();
    stubFailure(409, { error: "rewind 目标不是闭合边界" });

    const applied = await controller.face.retry(2, "truncate");

    expect(applied).toBe(false);
    expect(controller.store.getSnapshot()).toMatchObject({
      status: "ready",
      pending: null,
      error: "rewind 目标不是闭合边界",
    });
  });

  it("上一次操作未落定时不重复提交", async () => {
    const { sessions } = fakeSessions();
    const controller = controllerWith(sessions);
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return responseFor({ sessionId: "s1", queuedTurns: 0 });
    });

    const first = controller.face.recall(userBlock);
    const second = await controller.face.recall(userBlock);

    expect(second).toBe(false);
    release?.();
    await first;
  });
});
