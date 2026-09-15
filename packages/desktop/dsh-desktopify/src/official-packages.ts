// 官方插件包清单的搜集逻辑：复用上游装配 API（`loadOverlayPatches` +
// `composeEntries`）解析 dsh-base 与 dsh-web-app bundle 的 cordis.patch.yml，
// 取非禁用条目引用的 @deepseek-ai/* 包名（子路径行归到包名）。
//
// 生成器（scripts/gen-official-packages.ts）与守卫测试共用这一份实现：
// 清单不再手写，上游升级后重跑生成器即可。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 桌面组合叠加在上游之上的两个官方 bundle。 */
const OFFICIAL_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] as const;

/** 工具包根：源码形态 `src/` 与 `scripts/` 同深度。 */
export const DESKTOPIFY_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 从上游 bundle patch 搜集官方插件包名（排序去重）。
 *
 * 解析链复用工具自己的依赖面：`@deepseek-ai/dsh` 是工具的 dependencies，
 * app-boot 与两个 bundle 包都从它的安装里解析。
 */
export async function collectOfficialProfilePackages(): Promise<string[]> {
  const require = createRequire(join(DESKTOPIFY_PACKAGE_ROOT, "package.json"));
  const dshRequire = createRequire(
    join(dirname(require.resolve("@deepseek-ai/dsh/package.json")), "package.json"),
  );
  const appBoot = (await import(
    pathToFileURL(dshRequire.resolve("@deepseek-ai/dsh-app-boot")).href
  )) as typeof import("@deepseek-ai/dsh-app-boot");

  const layers = OFFICIAL_BUNDLES.map((name) =>
    appBoot.loadOverlayPatches(
      "dsh-desktopify",
      join(dirname(dshRequire.resolve(`${name}/package.json`)), "cordis.patch.yml"),
    ),
  );
  const packages = new Set<string>();
  for (const entry of appBoot.composeEntries(layers)) {
    if (entry.disabled === true) continue;
    const name = entry.name;
    if (typeof name !== "string" || !name.startsWith("@deepseek-ai/")) continue;
    const [scope, pkg] = name.split("/");
    if (scope === undefined || pkg === undefined) continue;
    packages.add(`${scope}/${pkg}`);
  }
  return [...packages].sort();
}
