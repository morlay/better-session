// 升级对齐守卫：旧 storages 导入的版本容忍集必须跟着上游域 spec 演进。
// 上游 bump 域版本（例如 projcache v8）时若不同步，旧文档会在导入侧静默跳过
// （数据丢失）；这里在 vendor 源文本上 fail loud，提示同步常量与迁移评估。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJCACHE_UNIT_VERSIONS, WORKSPACE_UNIT_VERSIONS } from "../import-storages.ts";

const repoRoot = process.cwd();
const VENDOR = join(repoRoot, "vendor/deepseek-harness/packages");

function specSource(path: string): string {
  return readFileSync(join(VENDOR, path), "utf8");
}

/** `version: N` 一行。 */
function declaredVersion(text: string): number {
  const match = /^\s*version: (\d+),$/m.exec(text);
  if (match === null) throw new Error("no `version:` declaration found in the spec source");
  return Number(match[1]);
}

/** `compatibleVersions: [a, b, c]`（缺省空集）。 */
function declaredCompatibleVersions(text: string): number[] {
  const match = /^\s*compatibleVersions: \[([^\]]*)\],$/m.exec(text);
  if (match === null) return [];
  return [...match[1]!.matchAll(/\d+/g)].map((entry) => Number(entry[0]));
}

describe("legacy storages import version sets", () => {
  it("covers the current session_projcache domain spec", () => {
    const text = specSource("session/session-projection-cache/src/spec.ts");
    expect(text).toMatch(/name: 'session_projcache'/);
    const expected = new Set([declaredVersion(text), ...declaredCompatibleVersions(text)]);
    expect(new Set(PROJCACHE_UNIT_VERSIONS)).toEqual(expected);
  });

  it("covers the current workspace domain spec", () => {
    const text = specSource("workspace/workspace/src/spec.ts");
    expect(text).toMatch(/name: 'workspace'/);
    expect(new Set(WORKSPACE_UNIT_VERSIONS)).toEqual(new Set([declaredVersion(text)]));
  });
});
