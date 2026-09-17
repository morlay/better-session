// connection 面的传输闭环：宿主内嵌（桌面壳）客户端打的是 `/api/session-editor`
// 这条 connection.fetch 路由——GET 取 timeline、POST 分发六种动作，
// 参数错误 400、编排冲突 409、方法不允许 405。
import { describe, expect, it } from "vitest";
import {
  createPersisted,
  harness,
  SessionIdBrand,
  SESSION_EDITOR_PATH,
  twoTurnLog,
} from "@morlay/ui-conversation-message-actions/testing";

type FetchRoute = (request: Request) => Promise<Response>;

const CONNECTION_PATH = `/api${SESSION_EDITOR_PATH}`;

async function harnessWithConnection(): Promise<{
  routes: Map<string, FetchRoute>;
  ctx: Awaited<ReturnType<typeof harness>>["ctx"];
  editor: Awaited<ReturnType<typeof harness>>["editor"];
  dispose: () => Promise<void>;
}> {
  const routes = new Map<string, FetchRoute>();
  const { ctx, editor, dispose } = await harness((scope) => {
    scope.provide("connection", {
      fetch: {
        register: (route: { path: string; fetch: FetchRoute }) => {
          routes.set(route.path, route.fetch);
          return async () => {};
        },
      },
    });
  });
  return { routes, ctx, editor, dispose };
}

function get(sessionId: string): Request {
  return new Request(`http://harness.invalid${CONNECTION_PATH}?sessionId=${sessionId}`, {
    method: "GET",
  });
}

function post(body: unknown): Request {
  return new Request(`http://harness.invalid${CONNECTION_PATH}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("session-editor connection 路由", () => {
  it("注册在 /api 前缀下（宿主内嵌客户端的路径）", async () => {
    const { routes, dispose } = await harnessWithConnection();
    try {
      expect(routes.has(CONNECTION_PATH)).toBe(true);
      expect(routes.has(SESSION_EDITOR_PATH)).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("GET 返回可编辑消息与可重试回合（timeline 负载）", async () => {
    const { routes, ctx, dispose } = await harnessWithConnection();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const response = await routes.get(CONNECTION_PATH)!(get("s1"));
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        sessionId: string;
        messages: Array<{ kind: string; text: string }>;
        retryableTurns: Array<{ turn: number; preview: string }>;
        versions: unknown[];
      };
      expect(payload.sessionId).toBe("s1");
      expect(payload.messages.filter((row) => row.kind === "user").map((row) => row.text)).toEqual([
        "hi",
        "hi",
      ]);
      expect(payload.retryableTurns.map((turn) => turn.turn)).toEqual([1, 2]);
      expect(payload.versions).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("POST edit 就地截断并落版本效果（无 agents 时不重放，会话 id 不变）", async () => {
    const { routes, ctx, dispose } = await harnessWithConnection();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const response = await routes.get(CONNECTION_PATH)!(
        post({
          action: "edit",
          sessionId: "s1",
          eventSeq: 1,
          blockIndex: 0,
          text: "edited",
          cascade: "truncate",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: "s1", queuedTurns: 0, live: false });

      const handle = await ctx.sessionPersistence.open(SessionIdBrand("s1"), "read");
      const { events } = await handle.read();
      await handle.close();
      expect(events.map((event) => event.type)).toEqual(["session-branch/version"]);
      expect(events[0]).toMatchObject({ ignorable: true });
    } finally {
      await dispose();
    }
  });

  it("POST recall 只截断、不重放（被撤回的轮次及其后内容消失）", async () => {
    const { routes, ctx, editor, dispose } = await harnessWithConnection();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const response = await routes.get(CONNECTION_PATH)!(
        post({ action: "recall", sessionId: "s1", eventSeq: 7 }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: "s1", queuedTurns: 0, live: false });

      const messages = await editor.editableMessages(SessionIdBrand("s1"));
      expect(messages.map((row) => row.text)).toEqual(["hi", "hello"]);
    } finally {
      await dispose();
    }
  });

  it("未知 action 与缺参数都是 400", async () => {
    const { routes, dispose } = await harnessWithConnection();
    try {
      const unknown = await routes.get(CONNECTION_PATH)!(
        post({ action: "explode", sessionId: "s1" }),
      );
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: expect.stringContaining("action") });

      const missing = await routes.get(CONNECTION_PATH)!(post({ action: "reroll" }));
      expect(missing.status).toBe(400);
    } finally {
      await dispose();
    }
  });

  it("编排冲突（越界 eventSeq）是 409", async () => {
    const { routes, ctx, dispose } = await harnessWithConnection();
    try {
      await createPersisted(ctx, "s1", twoTurnLog());
      const response = await routes.get(CONNECTION_PATH)!(
        post({
          action: "edit",
          sessionId: "s1",
          eventSeq: 9_999,
          blockIndex: 0,
          text: "x",
          cascade: "truncate",
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    } finally {
      await dispose();
    }
  });

  it("不支持的方法返回 405", async () => {
    const { routes, dispose } = await harnessWithConnection();
    try {
      const response = await routes.get(CONNECTION_PATH)!(
        new Request(`http://harness.invalid${CONNECTION_PATH}`, { method: "DELETE" }),
      );
      expect(response.status).toBe(405);
    } finally {
      await dispose();
    }
  });
});
