import { readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { UserConfig } from "tsdown";
import {
  CLIENT_ENTRY,
  clientBundleSpec,
  clientEntryPlugin,
  isClientExternal,
  type CordisClientOptions,
} from "./cordis-client.ts";

/** `existsSync` 的异步等价物：任何 stat 失败都算条目不存在。 */
async function entryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * cordis 插件包共享 tsdown 配置：host 与 client 是**同一次构建的两个入口**，
 * 因此 exports 与声明来自同一套产物视图（client 的差别由 {@link clientEntryPlugin}
 * 与按入口的 external 规则承担，不是第二个 config）。
 * entry 按约定探测（`src/index.ts`；`src/invariant.ts` 存在自动附带；
 * `src/client/index.ts` 存在自动附带 client 入口）。
 *
 * 异步：调用方把返回值直接作为 tsdown 配置的 default export 即可——
 * tsdown 的 `UserConfigExport` 本身接受 `Awaitable<UserConfig>`。
 */
export async function defineCordisPluginConfig(options?: {
  client?: CordisClientOptions | false;
  entries?: Record<string, string>;
}): Promise<UserConfig> {
  const hasClientSource = await entryExists(join(process.cwd(), "src", "client", "index.ts"));
  const client =
    options?.client === false || (!hasClientSource && options?.client === undefined)
      ? undefined
      : (options?.client ?? { name: await packageName(), entry: "./src/client/index.ts" });

  const entry: Record<string, string> = { index: "./src/index.ts", ...options?.entries };
  if (await entryExists(join(process.cwd(), "src", "invariant.ts"))) {
    entry["invariant"] = "./src/invariant.ts";
  }
  if (client !== undefined) entry[CLIENT_ENTRY] = client.entry ?? "./src/client/index.ts";

  const spec = clientBundleSpec(
    client?.externals === undefined ? {} : { externals: client.externals },
  );
  const clientRoot = `${sep}src${sep}${CLIENT_ENTRY}${sep}`;
  const fromClient = (importer: string | null | undefined): boolean =>
    typeof importer === "string" && importer.includes(clientRoot);

  return {
    name: client?.name ?? (await packageName()),
    entry,
    // client 产物是 CJS（模块系统的工厂契约），host 产物是 ESM；没有 client
    // 入口的包只产 ESM。
    format: client === undefined ? ["esm"] : ["esm", "cjs"],
    platform: "node",
    dts: true,
    sourcemap: false,
    clean: true,
    // 包的 exports 手写在 package.json（dev 指向源码、发布走 publishConfig），
    // tsdown 只负责产物，不去重写清单。
    exports: false,
    // 双模式库（如 lexical 的 exports 带 development / production / node 条件，
    // node 变体用 CJS 承载不了的 top-level await）必须解析到与下面 defines 一致
    // 的静态变体：条件名按 NODE_ENV 选 production / development，且不含 node。
    inputOptions: { resolve: { conditionNames: spec.conditionNames } },
    define: spec.define,
    deps: {
      // external 只对 client 入口的模块图生效：host 半照常打自己的依赖闭包。
      neverBundle: (id: string, importer: string | null | undefined) =>
        fromClient(importer) && isClientExternal(id, spec.externals),
      alwaysBundle: (id: string, importer: string | null | undefined) =>
        fromClient(importer) && !isClientExternal(id, spec.externals),
    },
    plugins:
      client === undefined
        ? []
        : [
            clientEntryPlugin({
              name: client.name,
              entry: client.entry ?? "./src/client/index.ts",
              ...(client.externals === undefined ? {} : { externals: client.externals }),
            }),
          ],
  };
}

async function packageName(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    name?: string;
  };
  if (!pkg.name) throw new Error("package.json 缺少 name");
  return pkg.name;
}
