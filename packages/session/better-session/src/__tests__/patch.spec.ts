import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const PATCH_PATH = join(repoRoot, "packages/session/better-session/cordis.patch.yml");
const BUNDLE_ROOT = join(repoRoot, "vendor/deepseek-harness/packages/bundle");

const patch = await readFile(PATCH_PATH, "utf8");

function disabledIds(text: string): string[] {
  return [...text.matchAll(/^- id: (\S+)\n {2}disabled: true$/gm)].map((match) => match[1]!);
}

function configuredIds(text: string): string[] {
  return [...text.matchAll(/^- id: (\S+)\n {2}config:$/gm)].map((match) => match[1]!);
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

describe("better-session patch wiring", () => {
  it("targets upstream bundle rows that still exist", () => {
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
      "ui-chat",
      "ui-conversation",
      "ui-input-trigger",
    ]);
  });

  it("inserts morlay rows without colliding with upstream ids", () => {
    const inserted = insertedIds(patch);
    expect(inserted.sort()).toEqual([
      "session-branch",
      "session-rdb",
      "ui-chat-fork",
      "ui-conversation-fork",
      "ui-conversation-message-actions",
      "ui-input-trigger-fork",
      "ui-primitives-fork",
    ]);
    for (const id of inserted) expect(upstreamIds.has(id)).toBe(false);
  });
});
