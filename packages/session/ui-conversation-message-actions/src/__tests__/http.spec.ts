// HTTP 面守卫：POST /session-editor 的 rewind 也必须先停止运行中的 loop
// （handler → 公共 rewind → stopLoop）。路由由 SessionEditor 构造函数内的
// effect 注册，webServer 替身须在本插件装配前就绪。

import { describe, expect, it } from "vitest";
import {
  harness,
  meta,
  SessionIdBrand,
  SESSION_EDITOR_PATH,
  twoTurnLog,
} from "@morlay/ui-conversation-message-actions/testing";

interface FakeRequest {
  method?: string;
  url?: string;
  on(event: string, listener: (arg?: unknown) => void): FakeRequest;
}

interface FakeResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): void;
}

type RouteHandler = (request: FakeRequest, response: FakeResponse) => void | Promise<void>;

// 最小 POST 请求替身：每次注册回调后按序投递单块 body 与 end。
function fakeJsonRequest(body: unknown): FakeRequest {
  const chunk = Buffer.from(JSON.stringify(body));
  const request: FakeRequest = {
    method: "POST",
    url: SESSION_EDITOR_PATH,
    on(event, listener) {
      if (event === "data") queueMicrotask(() => listener(chunk));
      if (event === "end") queueMicrotask(() => listener());
      return request;
    },
  };
  return request;
}

// 最小响应替身：记录 status 与 body。
function fakeResponse(): { response: FakeResponse; code: number; body: string } {
  const state = {
    response: undefined as unknown as FakeResponse,
    code: 0,
    body: "",
  };
  state.response = {
    writeHead: (status: number) => {
      state.code = status;
      return state.response;
    },
    end: (body?: string) => {
      if (body !== undefined) state.body = body;
    },
  };
  return state;
}

describe("session-editor HTTP 面", () => {
  it("stops the running live agent's loop before a rewind action truncates", async () => {
    const routes = new Map<string, RouteHandler>();
    const { ctx, dispose } = await harness((scope) => {
      scope.provide("webServer", {
        register: (route: { path: string; handler: RouteHandler }) => {
          routes.set(route.path, route.handler);
          return () => {};
        },
      });
    });
    try {
      // 路由注册随插件激活的 effect 执行；本用例无真实 IO，microtask 轮询足够。
      for (let i = 0; i < 1000 && !routes.has(SESSION_EDITOR_PATH); i += 1) await Promise.resolve();
      expect(routes.has(SESSION_EDITOR_PATH)).toBe(true);

      ctx.sessions.create(SessionIdBrand("busy"), {
        meta: meta("busy"),
        seed: [...twoTurnLog()],
      });
      const live = ctx.sessions.get(SessionIdBrand("busy"))!;
      await ctx.sessions.flush(live);
      const before = live.snapshotEvents().length;

      const calls: string[] = [];
      const cancels: Array<{ cause: unknown; options: unknown }> = [];
      const disposeAgents = ctx.provide("agents", {
        get: (id: SessionIdBrand) =>
          id === SessionIdBrand("busy")
            ? {
                session: live,
                followup: () => {},
                cancel: (cause: unknown, options: unknown) => {
                  calls.push("cancel");
                  cancels.push({ cause, options });
                },
                whenIdle: async () => {
                  calls.push("whenIdle");
                  // 收敛等待期间 HTTP rewind 尚未截断。
                  expect(live.snapshotEvents()).toHaveLength(before);
                },
              }
            : undefined,
      });

      const response = fakeResponse();
      await routes.get(SESSION_EDITOR_PATH)!(
        fakeJsonRequest({ action: "rewind", sessionId: "busy", toBoundary: 5 }),
        response.response,
      );

      expect(response.code).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ sessionId: "busy", queuedTurns: 0 });
      // handler → 公共 rewind：先停止 loop（cancel → whenIdle），再截断。
      expect(calls).toEqual(["cancel", "whenIdle"]);
      expect(cancels[0]).toEqual({ cause: { kind: "user" }, options: { keepInbox: true } });
      expect(live.snapshotEvents().map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });
});
