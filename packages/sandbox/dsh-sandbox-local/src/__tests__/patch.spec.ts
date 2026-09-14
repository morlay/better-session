// 装配守卫：本包的 patch 必须继续对准上游 bundle 的装配行——上游改名或移动
// `sandbox` / `fs-sandbox` 时在这里 fail loud，而不是让“官方实现仍被装载、
// 我们的替换静默失效”这种最难发现的状态存在。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const PATCH_PATH = join(repoRoot, "packages/sandbox/dsh-sandbox-local/cordis.patch.yml");
const BUNDLE_ROOT = join(repoRoot, "vendor/deepseek-harness/packages/bundle");

const patch = readFileSync(PATCH_PATH, "utf8");

/** 顶层 `- id: X` 后紧跟 `  disabled: true` 的条目。 */
function disabledIds(text: string): string[] {
  return [...text.matchAll(/^- id: (\S+)\n {2}disabled: true$/gm)].map((match) => match[1]!);
}

/** `- insert:` 列表里新增的 id。 */
function insertedIds(text: string): string[] {
  const block = text.split(/^- insert:\s*$/m)[1];
  if (block === undefined) return [];
  return [...block.matchAll(/^ {4}- id: (\S+)$/gm)].map((match) => match[1]!);
}

/** 一个上游 bundle patch 里出现过的全部 id（顶层与 insert 内）。 */
function bundleIds(file: string): Set<string> {
  const text = readFileSync(file, "utf8");
  return new Set([...text.matchAll(/^\s*- id: (\S+)$/gm)].map((match) => match[1]!));
}

const upstreamIds = new Set([
  ...bundleIds(join(BUNDLE_ROOT, "base/cordis.patch.yml")),
  ...bundleIds(join(BUNDLE_ROOT, "web-app/cordis.patch.yml")),
]);

describe("sandbox-local patch wiring", () => {
  it("禁用的官方行仍然存在于上游 bundle 里", () => {
    const disabled = disabledIds(patch);
    expect(disabled.sort()).toEqual(["fs-sandbox", "sandbox"]);
    for (const id of disabled)
      expect(upstreamIds.has(id), `missing upstream row: ${id}`).toBe(true);
  });

  it("插入的自有行不与上游 id 冲突", () => {
    const inserted = insertedIds(patch);
    expect(inserted).toEqual(["sandbox-local"]);
    for (const id of inserted) expect(upstreamIds.has(id)).toBe(false);
  });
});
