import { describe, expect, it } from "vitest";
import {
  createPersisted,
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

      expect(calls).toEqual(["cancel", "whenIdle"]);
      expect(cancels[0]).toEqual({ cause: { kind: "user" }, options: { keepInbox: true } });
      expect(live.snapshotEvents().map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      disposeAgents();
    } finally {
      await dispose();
    }
  });

  it("GET 取 timeline，参数非法是 400（web 模式下浏览器半的入口）", async () => {
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
      for (let i = 0; i < 1000 && !routes.has(SESSION_EDITOR_PATH); i += 1) await Promise.resolve();
      const handler = routes.get(SESSION_EDITOR_PATH)!;
      await createPersisted(ctx, "s1", twoTurnLog());

      const listed = fakeResponse();
      const request: FakeRequest = {
        method: "GET",
        url: `${SESSION_EDITOR_PATH}?sessionId=s1`,
        on() {
          return request;
        },
      };
      await handler(request, listed.response);
      expect(listed.code).toBe(200);
      expect(JSON.parse(listed.body)).toMatchObject({
        sessionId: "s1",
        retryableTurns: [{ turn: 1 }, { turn: 2 }],
      });

      const rejected = fakeResponse();
      await handler(fakeJsonRequest({ action: "explode", sessionId: "s1" }), rejected.response);
      expect(rejected.code).toBe(400);
    } finally {
      await dispose();
    }
  });
});
