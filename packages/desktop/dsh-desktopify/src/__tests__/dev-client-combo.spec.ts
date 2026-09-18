import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { apply } from "../dev-client/index.ts";
import { comboEntryIds, stripSourceMapTrailer } from "../dev-client/combo.ts";

describe("comboEntryIds", () => {
  it("reads the package list out of a combo URL", () => {
    expect(
      comboEntryIds(
        "/plugins/??@morlay/example-plugin/client.js,@deepseek-ai/dsh-client-ui-slots/client.js&rev=abc123",
      ),
    ).toEqual(["@morlay/example-plugin", "@deepseek-ai/dsh-client-ui-slots"]);
  });

  it("accepts the single-resource form", () => {
    expect(comboEntryIds("/plugins/??react/client.js&rev=abc123")).toEqual(["react"]);
  });

  it("rejects source-map resources, non-combo paths, and empty lists", () => {
    expect(comboEntryIds("/plugins/??a/client.js.map&rev=abc")).toBeUndefined();
    expect(comboEntryIds("/plugins/a/client.js")).toBeUndefined();
    expect(comboEntryIds("/plugins/??&rev=abc")).toBeUndefined();
    expect(comboEntryIds("/plugins/events")).toBeUndefined();
  });
});

describe("stripSourceMapTrailer", () => {
  it("drops the trailer and keeps the body", () => {
    expect(
      stripSourceMapTrailer("var a = 1;\n//# sourceMappingURL=/plugins/??x/client.js.map\n"),
    ).toBe("var a = 1;\n");
  });

  it("leaves a trailer-free bundle untouched", () => {
    expect(stripSourceMapTrailer("var a = 1;\n")).toBe("var a = 1;\n");
  });
});

// 路由接缝：只有带 dev 前缀的 combo 由本插件现场打包，其余（上游包）必须原样
// 委托给 clientModules.fetchBundle —— 它是 async，漏 await 会让上游 bundle 请求失败。
interface RouteHarness {
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  fetchBundle: ReturnType<typeof vi.fn>;
}

function routeHarness(moduleResponse: Response): RouteHarness {
  const routes: Array<{ handler: RouteHarness["handler"] }> = [];
  const fetchBundle = vi.fn(async () => moduleResponse);
  const ctx = {
    get: (name: string) => {
      if (name === "webServer")
        return {
          register: (route: { handler: RouteHarness["handler"] }) => {
            routes.push(route);
            return () => {};
          },
        };
      if (name === "clientModules")
        return { graph: () => ({ entries: [] }), clientPath: () => undefined, fetchBundle };
      return undefined;
    },
    effect: (fn: () => unknown) => {
      fn();
    },
    logger: { error: () => {} },
  };
  apply(ctx as never, {});
  const handler = routes[0]?.handler;
  if (handler === undefined) throw new Error("dev-client-bundles did not register its route");
  return { handler, fetchBundle };
}

function exchange(
  handler: RouteHarness["handler"],
  url: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    const res = {
      writeHead(next: number) {
        status = next;
      },
      end(body?: unknown) {
        resolve({ status, body });
      },
    } as unknown as ServerResponse;
    const req = { method: "GET", url } as IncomingMessage;
    void Promise.resolve(handler(req, res)).catch(reject);
  });
}

describe("dev-client-bundles /plugins route", () => {
  it("delegates an upstream-only combo to clientModules.fetchBundle", async () => {
    const { handler, fetchBundle } = routeHarness(
      new Response("upstream-bundle", {
        status: 200,
        headers: { "content-type": "text/javascript" },
      }),
    );

    const result = await exchange(
      handler,
      "/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=abc",
    );

    expect(fetchBundle).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(Buffer.from(result.body as Uint8Array).toString()).toBe("upstream-bundle");
  });

  it("delegates a request without a combo list", async () => {
    const { handler, fetchBundle } = routeHarness(new Response(null, { status: 404 }));

    const result = await exchange(handler, "/plugins/");

    expect(fetchBundle).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(404);
  });
});
