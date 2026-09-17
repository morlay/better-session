import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJCACHE_UNIT_VERSIONS, WORKSPACE_UNIT_VERSIONS } from "../import-storages.ts";

const repoRoot = process.cwd();
const VENDOR = join(repoRoot, "vendor/deepseek-harness/packages");

function specSource(path: string): Promise<string> {
  return readFile(join(VENDOR, path), "utf8");
}

function declaredVersion(text: string): number {
  const match = /^\s*version: (\d+),$/m.exec(text);
  if (match === null) throw new Error("no `version:` declaration found in the spec source");
  return Number(match[1]);
}

function declaredCompatibleVersions(text: string): number[] {
  const match = /^\s*compatibleVersions: \[([^\]]*)\],$/m.exec(text);
  if (match === null) return [];
  return [...match[1]!.matchAll(/\d+/g)].map((entry) => Number(entry[0]));
}

describe("legacy storages import version sets", () => {
  it("covers the current session_projcache domain spec", async () => {
    const text = await specSource("session/session-projection-cache/src/spec.ts");
    expect(text).toMatch(/name: 'session_projcache'/);
    const expected = new Set([declaredVersion(text), ...declaredCompatibleVersions(text)]);
    expect(new Set(PROJCACHE_UNIT_VERSIONS)).toEqual(expected);
  });

  it("covers the current workspace domain spec", async () => {
    const text = await specSource("workspace/workspace/src/spec.ts");
    expect(text).toMatch(/name: 'workspace'/);
    expect(new Set(WORKSPACE_UNIT_VERSIONS)).toEqual(new Set([declaredVersion(text)]));
  });
});
