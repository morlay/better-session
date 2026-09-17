import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const PATCH_PATH = join(repoRoot, "packages/sandbox/dsh-sandbox-local/cordis.patch.yml");
const BUNDLE_ROOT = join(repoRoot, "vendor/deepseek-harness/packages/bundle");

const patch = await readFile(PATCH_PATH, "utf8");

function disabledIds(text: string): string[] {
  return [...text.matchAll(/^- id: (\S+)\n {2}disabled: true$/gm)].map((match) => match[1]!);
}

function insertedIds(text: string): string[] {
  const block = text.split(/^- insert:\s*$/m)[1];
  if (block === undefined) return [];
  return [...block.matchAll(/^ {4}- id: (\S+)$/gm)].map((match) => match[1]!);
}

async function bundleIds(file: string): Promise<Set<string>> {
  const text = await readFile(file, "utf8");
  return new Set([...text.matchAll(/^\s*- id: (\S+)$/gm)].map((match) => match[1]!));
}

const upstreamIds = new Set([
  ...(await bundleIds(join(BUNDLE_ROOT, "base/cordis.patch.yml"))),
  ...(await bundleIds(join(BUNDLE_ROOT, "web-app/cordis.patch.yml"))),
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
