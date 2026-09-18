import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const BOOT = "<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>";

export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  const target = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  const directory = resolve(root);
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 });
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return new Response(null, { status: 404 });
    throw error;
  }
  const content =
    pathname === "/" || pathname === "/index.html"
      ? body.toString().replace("<head>", `<head>${BOOT}`)
      : new Uint8Array(body);
  return new Response(request.method === "HEAD" ? null : content, {
    headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream" },
  });
}

export async function authenticateWebHost(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie");
  await response.body?.cancel();
  if (response.status !== 303 || cookie === null)
    throw new Error("dsh desktop: Host authentication failed");
  const end = cookie.indexOf(";");
  return end < 0 ? cookie : cookie.slice(0, end);
}

export async function forwardWebRequest(
  request: Request,
  host: string,
  cookie: string,
): Promise<Response> {
  const source = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "dsh-app://app") return new Response(null, { status: 403 });
  const target = new URL(host);
  target.pathname = source.pathname;
  target.search = source.search;
  const headers = new Headers(request.headers);
  for (const name of ["host", "origin", "cookie", "sec-fetch-site"]) headers.delete(name);
  headers.set("cookie", cookie);
  const init = {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    duplex: "half",
    redirect: "manual" as const,
  };
  const response = await fetch(target, init);
  const outgoing = new Headers(response.headers);
  for (const name of ["content-encoding", "content-length", "set-cookie"]) outgoing.delete(name);
  return new Response(response.body, { status: response.status, headers: outgoing });
}
