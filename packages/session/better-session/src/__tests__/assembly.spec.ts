import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const patchPath = join(repoRoot, "packages/session/better-session/cordis.patch.yml");
const patch = await readFile(patchPath, "utf8");
const manifest = JSON.parse(
  await readFile(join(repoRoot, "packages/session/better-session/package.json"), "utf8"),
) as { dependencies: Record<string, string> };

function insertedPackageNames(text: string): string[] {
  const block = text.split(/^- insert:\s*$/m)[1] ?? "";
  return [...block.matchAll(/^ {4}- id: (\S+)\n {6}name: "([^"]+)"$/gm)].map((match) => match[2]!);
}

interface WorkspaceManifest {
  name?: string;
  exports?: Record<string, { types?: string; default?: string }>;
  dsh?: { client?: { platform?: string; inject?: readonly string[] } };
}

const workspaces = new Map<string, WorkspaceManifest>();
for (const family of await readdir(join(repoRoot, "packages"))) {
  for (const entry of await readdir(join(repoRoot, "packages", family))) {
    let parsed: WorkspaceManifest;
    try {
      parsed = JSON.parse(
        await readFile(join(repoRoot, "packages", family, entry, "package.json"), "utf8"),
      ) as WorkspaceManifest;
    } catch {
      continue;
    }
    if (parsed.name !== undefined) workspaces.set(parsed.name, parsed);
  }
}

function manifestOf(packageName: string): WorkspaceManifest {
  const found = workspaces.get(packageName);
  if (found === undefined) throw new Error(`no workspace package named ${packageName}`);
  return found;
}

describe("better-session 装配面", () => {
  it("patch 插入的每个包都是本 bundle 的依赖，反之亦然（发布不断链）", () => {
    const inserted = insertedPackageNames(patch).sort();
    expect(inserted.length).toBeGreaterThan(0);

    const declared = Object.keys(manifest.dependencies).sort();
    expect(inserted).toEqual(declared);
    for (const name of inserted) expect(manifestOf(name).name).toBe(name);
  });

  it("patch 里的每个 insert 行都真实落在工作区内", () => {
    for (const name of insertedPackageNames(patch)) {
      const found = manifestOf(name);
      expect(found.name, `missing workspace package for ${name}`).toBe(name);
      expect(found.exports?.["."], `${name} has no host entry`).toBeDefined();
    }
  });

  it("fork 的 client 半声明了 client-modules 需要的入口与平台", () => {
    const clientForkPackages = insertedPackageNames(patch).filter((name) =>
      name.startsWith("@morlay/dsh-client-ui-"),
    );
    expect(clientForkPackages.length).toBeGreaterThan(0);
    for (const name of clientForkPackages) {
      const entry = manifestOf(name).exports?.["./client"];
      expect(entry?.types, `${name} client types`).toBeDefined();
      expect(entry?.default, `${name} client bundle`).toBeDefined();
      expect(manifestOf(name).dsh?.client?.platform).toBe("web");
    }
  });

  it("编排层的 client 半注入连接服务（宿主内嵌走 connection 路由）", () => {
    const client = manifestOf("@morlay/ui-conversation-message-actions").dsh?.client;
    expect(client?.platform).toBe("web");
    expect(client?.inject ?? []).toContain("@deepseek-ai/dsh-client-connection");
    expect(client?.inject ?? []).toContain("@deepseek-ai/dsh-client-store");
  });
});
