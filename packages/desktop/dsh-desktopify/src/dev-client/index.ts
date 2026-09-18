import { access, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { bundleClientFactory } from "@local/devkit";
import { COMBO_PATH, comboEntryIds, stripSourceMapTrailer } from "./combo.ts";

export const name = "dev-client-bundles";

export const inject = ["webServer", "clientModules"];

export interface Config {
  prefixes?: string[];

  packages?: string[];
}

interface RouteHost {
  register(route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

interface ModuleTable {
  graph(): { entries: readonly { id: string }[] };
  clientPath(id: string): string | undefined;
  fetchBundle(request: Request): Promise<Response>;
}

const DEFAULT_PREFIXES = ["@morlay/"];

function escapeRegExp(value: string): string {
  return value.replace(/[/\\^$*+?.()|[\]{}]/gu, "\\$&");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function clientEntryOf(clientPath: string): Promise<string> {
  let directory = dirname(clientPath);
  while (directory !== dirname(directory)) {
    if (await pathExists(join(directory, "package.json")))
      return join(directory, "src", "client", "index.ts");
    directory = dirname(directory);
  }
  throw new Error(`dev-client-bundles: no package root above ${clientPath}`);
}

export function apply(ctx: Context, config: Config = {}): void {
  const webServer = ctx.get("webServer") as RouteHost | undefined;
  const modules = ctx.get("clientModules") as ModuleTable | undefined;
  if (webServer === undefined || modules === undefined)
    throw new Error("dev-client-bundles: webServer and clientModules are required services");

  const prefixes = config.prefixes ?? DEFAULT_PREFIXES;
  const explicit = new Set(config.packages ?? []);
  const isDevPackage = (id: string): boolean =>
    explicit.has(id) || prefixes.some((prefix) => id.startsWith(prefix));

  const devExternals = (): (string | RegExp)[] =>
    modules
      .graph()
      .entries.map((entry) => entry.id)
      .filter(isDevPackage)
      .map((id) => new RegExp(`^${escapeRegExp(id)}(?:/|$)`));

  const builtPathOf = (id: string): string => {
    const path = modules.clientPath(id);
    if (path === undefined) throw new Error(`dev-client-bundles: ${id} is not a client module row`);
    return path;
  };

  const bundleSource = async (id: string, externals: (string | RegExp)[]): Promise<string> => {
    const entry = await clientEntryOf(builtPathOf(id));
    if (!(await pathExists(entry)))
      throw new Error(`dev-client-bundles: ${id} has no client source at ${entry}`);
    return await bundleClientFactory({ name: id, entry, externals });
  };

  const readBuilt = async (id: string): Promise<string> =>
    stripSourceMapTrailer(await readFile(builtPathOf(id), "utf8"));

  const fallback = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let response: Response;
    try {
      response = await modules.fetchBundle(
        new Request(new URL(req.url ?? COMBO_PATH, "http://dsh.invalid"), {
          method: req.method ?? "GET",
        }),
      );
    } catch (error) {
      ctx.logger.error(error);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("dev-client-bundles: clientModules.fetchBundle failed\n");
      return;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  };

  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const ids = comboEntryIds(req.url ?? COMBO_PATH);
    if ((req.method !== "GET" && req.method !== "HEAD") || ids === undefined)
      return fallback(req, res);
    if (!ids.some(isDevPackage)) return fallback(req, res);
    try {
      const externals = devExternals();
      const parts = await Promise.all(
        ids.map(async (id) =>
          isDevPackage(id) ? await bundleSource(id, externals) : readBuilt(id),
        ),
      );
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : parts.join("\n"));
    } catch (error) {
      ctx.logger.error(error);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  ctx.effect(
    () => webServer.register({ kind: "exact", path: COMBO_PATH, handler: serve }),
    "dev-client-bundles: /plugins route",
  );
}
