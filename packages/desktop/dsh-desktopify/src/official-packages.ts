import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OFFICIAL_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] as const;

export const DESKTOPIFY_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
