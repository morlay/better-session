import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = dirname(
  fileURLToPath(import.meta.resolve("@morlay/dsh-desktop-host/package.json")),
);
const ENTRY = join(PACKAGE_ROOT, "lib", "index.js");
const BUILT = await access(ENTRY).then(
  () => true,
  () => false,
);

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** 产物里的裸 import 说明运行期依赖；相对路径与 node: 内建除外。 */
async function entryImports(): Promise<Set<string>> {
  const source = await readFile(ENTRY, "utf8");
  const names = new Set<string>();
  // 只认行首的 ESM import 语句：产物里的字符串字面量也含 "import"。
  for (const match of source.matchAll(/^import\s+(?:[^"'`]*?\sfrom\s+)?"([^"]+)"/gmu)) {
    const specifier = match[1] as string;
    if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
    const segments = specifier.split("/");
    names.add(
      segments[0]?.startsWith("@") === true ? `${segments[0]}/${segments[1]}` : segments[0]!,
    );
  }
  return names;
}

describe("desktop host 发布清单", () => {
  it("不声明上游 app 的组合依赖（office 已移除）", async () => {
    const manifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as Manifest;

    // 变体不挂 docx / pptx / xlsx 技能：从上游 app manifest 抄来的依赖会让部署去装它。
    expect(manifest.dependencies?.["@deepseek-ai/dsh-skill-office"]).toBeUndefined();
    for (const name of [
      "@deepseek-ai/dsh-agent",
      "@deepseek-ai/dsh-jobs",
      "@deepseek-ai/dsh-tools",
    ]) {
      expect(manifest.dependencies?.[name]).toBeUndefined();
    }
  });

  it.skipIf(!BUILT)("清单与产物互相覆盖：声明即用到，用到即声明", async () => {
    const manifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as Manifest;
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const used = await entryImports();

    expect([...used].filter((name) => !declared.has(name))).toEqual([]);
    expect([...declared].filter((name) => !used.has(name))).toEqual([]);
  });
});
