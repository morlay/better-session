import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

// 工作区内包的 client 半运行期是浏览器模块工厂（window.__ModuleLoader__），
// node 侧不可加载；按 exports 的 types 解析回 TS 源码。
async function clientSourceAliases(): Promise<{ find: string; replacement: string }[]> {
  const aliases: { find: string; replacement: string }[] = [];
  const packagesDir = join(root, "packages");
  for (const scope of await readdir(packagesDir, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    const scopeDir = join(packagesDir, scope.name);
    for (const entry of await readdir(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(scopeDir, entry.name);
      const manifest = join(directory, "package.json");
      let text: string;
      try {
        text = await readFile(manifest, "utf8");
      } catch {
        // 读取失败（多半是没有 package.json）等同于原先的 existsSync 判空：跳过。
        continue;
      }
      const parsed = JSON.parse(text) as {
        name?: unknown;
        exports?: Record<string, { types?: unknown } | string>;
      };
      const client = parsed.exports?.["./client"];
      const types = typeof client === "object" ? client.types : undefined;
      if (typeof parsed.name !== "string" || typeof types !== "string") continue;
      aliases.push({ find: `${parsed.name}/client`, replacement: join(directory, types) });
    }
  }
  return aliases;
}

export default defineConfig(async () => ({
  resolve: { alias: await clientSourceAliases() },
  test: {
    include: [
      "packages/**/src/__tests__/**/*.spec.ts",
      "packages/**/src/__tests__/**/*.spec.tsx",
      // 共享工具链（devkit）的测试与被它服务的包同形：src/__tests__/*.spec.ts。
      "devpackages/**/src/__tests__/**/*.spec.ts",
    ],
    exclude: ["**/node_modules/**", "target/**"],
  },
}));
