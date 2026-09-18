import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateWebHost, forwardWebRequest, serveWebDocument } from "../web-document.ts";

const roots: string[] = [];

async function documentRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-web-"));
  roots.push(root);
  await writeFile(
    join(root, "index.html"),
    "<html><head></head><body><div id='root'></div></body></html>",
  );
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "app.js"), "export const head = '<head>';\n");
  return root;
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(response: Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response);
  });
  return calls;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("application document", () => {
  it("injects the boot gate into the index only", async () => {
    const root = await documentRoot();
    const index = await serveWebDocument(new Request("dsh-app://app/"), root);
    const asset = await serveWebDocument(new Request("dsh-app://app/assets/app.js"), root);

    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain(
      "<head><script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>",
    );
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await asset.text()).toBe("export const head = '<head>';\n");
  });

  it("serves the index for the html path and answers HEAD without a body", async () => {
    const root = await documentRoot();
    const response = await serveWebDocument(
      new Request("dsh-app://app/index.html", { method: "HEAD" }),
      root,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuses unavailable, escaping, malformed, and non-read requests", async () => {
    const root = await documentRoot();

    expect((await serveWebDocument(new Request("dsh-app://app/missing.css"), root)).status).toBe(
      404,
    );
    expect(
      (await serveWebDocument(new Request("dsh-app://app/%2e%2e%2fsecret.txt"), root)).status,
    ).toBe(403);
    expect((await serveWebDocument(new Request("dsh-app://app/%ZZ"), root)).status).toBe(400);
    expect(
      (await serveWebDocument(new Request("dsh-app://app/", { method: "POST" }), root)).status,
    ).toBe(405);
  });
});

describe("host authentication", () => {
  it("exchanges the launch URL for the authority cookie", async () => {
    const calls = stubFetch(
      new Response(null, {
        status: 303,
        headers: { "set-cookie": "dsh-session=abc; Path=/; HttpOnly; SameSite=Lax" },
      }),
    );

    await expect(authenticateWebHost("http://127.0.0.1:19387/?token=abc")).resolves.toBe(
      "dsh-session=abc",
    );
    expect(calls[0]?.url).toBe("http://127.0.0.1:19387/?token=abc");
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("refuses a Host that does not answer with a redirect carrying a cookie", async () => {
    stubFetch(new Response(null, { status: 200 }));
    await expect(authenticateWebHost("http://127.0.0.1:19387/")).rejects.toThrow(
      /authentication failed/u,
    );

    stubFetch(new Response(null, { status: 303 }));
    await expect(authenticateWebHost("http://127.0.0.1:19387/")).rejects.toThrow(
      /authentication failed/u,
    );
  });
});

describe("host forwarding", () => {
  it("forwards the application request to the Host with the authenticated cookie", async () => {
    const calls = stubFetch(
      new Response("hello", {
        status: 200,
        headers: { "content-encoding": "gzip", "content-length": "5", "set-cookie": "x=1" },
      }),
    );
    const request = new Request("dsh-app://app/api/session-editor?limit=2", {
      method: "POST",
      headers: {
        origin: "dsh-app://app",
        host: "app",
        cookie: "stale=1",
        "content-type": "application/json",
      },
      body: "{}",
    });

    const response = await forwardWebRequest(
      request,
      "http://127.0.0.1:19387/?token=abc",
      "dsh-session=abc",
    );

    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:19387/api/session-editor?limit=2");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("cookie")).toBe("dsh-session=abc");
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(await new Response(call?.init.body as ReadableStream).text()).toBe("{}");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("hello");
  });

  it("refuses requests from an origin the application document does not own", async () => {
    stubFetch(new Response(null, { status: 200 }));
    const request = new Request("dsh-app://app/api/session-editor", {
      headers: { origin: "https://evil.invalid" },
    });

    expect((await forwardWebRequest(request, "http://127.0.0.1:19387/", "c=1")).status).toBe(403);
  });

  it("carries a response body without buffering it", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      },
    });
    stubFetch(new Response(stream, { status: 200 }));

    const response = await forwardWebRequest(
      new Request("dsh-app://app/api/session-editor"),
      "http://127.0.0.1:19387/",
      "c=1",
    );

    expect(await response.text()).toBe("firstsecond");
  });
});
