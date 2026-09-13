// 装配守卫：better-session 的 patch 目标（禁用 / 配置覆盖 / 新增行）必须与
// vendor 的上游 bundle 层对齐——上游改名或移动装配行时在这里 fail loud，
// 而不是让禁用/覆盖静默失效（升级适配点之一）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const PATCH_PATH = join(repoRoot, "packages/session/better-session/cordis.patch.yml");
const BUNDLE_ROOT = join(repoRoot, "vendor/deepseek-harness/packages/bundle");

const patch = readFileSync(PATCH_PATH, "utf8");

/** 顶层 `- id: X` 后紧跟 `  disabled: true` 的条目。 */
function disabledIds(text: string): string[] {
  return [...text.matchAll(/^- id: (\S+)\n {2}disabled: true$/gm)].map((match) => match[1]!);
}

/** 顶层 `- id: X` 后跟 `  config:` 的条目（按 id 覆盖配置）。 */
function configuredIds(text: string): string[] {
  return [...text.matchAll(/^- id: (\S+)\n {2}config:$/gm)].map((match) => match[1]!);
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

describe("better-session patch wiring", () => {
  it("targets upstream bundle rows that still exist", () => {
    // 每个禁用/覆盖目标都必须能在上游 bundle 层里找到：上游改名后这里失败，
    // 提示同步 patch（而不是静默保留官方插件装载）。
    const targets = [...disabledIds(patch), ...configuredIds(patch)];
    expect(targets.length).toBeGreaterThan(0);
    for (const id of targets) expect(upstreamIds.has(id), `missing upstream row: ${id}`).toBe(true);
  });

  it("disables exactly the documented official rows", () => {
    expect(disabledIds(patch).sort()).toEqual([
      "session-log-deepseek",
      "session-persistence-jsonl",
      "session-projection-cache",
      "session-query-sqlite",
      "session-telemetry-otel",
      "storage-json",
    ]);
  });

  it("inserts morlay rows without colliding with upstream ids", () => {
    const inserted = insertedIds(patch);
    expect(inserted.sort()).toEqual([
      "session-branch",
      "session-rdb",
      "ui-conversation-message-actions",
    ]);
    for (const id of inserted) expect(upstreamIds.has(id)).toBe(false);
  });
});
