import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCordisClientConfig, type CordisClientOptions } from "./cordis-client.ts";
import type { UserConfig } from "tsdown";

/**
 * cordis 插件包共享 tsdown 配置：单入口，host / client 产物内部组装。
 * entry 按约定探测（`src/index.ts`；`src/invariant.ts` 存在自动附带；
 * `src/client/index.ts` 存在自动附带 client 产物并声明 `./client` export）。
 */
export function defineCordisPluginConfig(options?: {
  client?: CordisClientOptions | false;
  entries?: Record<string, string>;
}): UserConfig | UserConfig[] {
  const entry: Record<string, string> = { index: "./src/index.ts", ...options?.entries };
  const customExports: Record<string, unknown> = {
    "./cordis.patch.yml": "./cordis.patch.yml",
  };
  const hasClientSource = existsSync(join(process.cwd(), "src", "client", "index.ts"));
  if (existsSync(join(process.cwd(), "src", "invariant.ts"))) {
    entry["invariant"] = "./src/invariant.ts";
  }
  if (options?.client !== false && (hasClientSource || options?.client !== undefined)) {
    customExports["./client"] = "./dist/client.js";
  }

  const host: UserConfig = {
    entry,
    exports: {
      packageJson: true,
      devExports: true,
      customExports,
    },
    format: ["esm"],
    deps: { onlyBundle: false },
    clean: true,
  };

  const client: CordisClientOptions | undefined =
    options?.client === false || !hasClientSource && options?.client === undefined
      ? undefined
      : options?.client ?? { name: packageName(), entry: "src/client/index.ts" };

  return client === undefined ? host : [host, defineCordisClientConfig(client)];
}

function packageName(): string {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    name?: string;
  };
  if (!pkg.name) throw new Error("package.json 缺少 name");
  return pkg.name;
}
