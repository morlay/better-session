import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedFingerprint } from "../cli/prepare-seed.ts";

const roots: string[] = [];

function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-desktopify-fingerprint-"));
  roots.push(root);
  return root;
}

function write(path: string, content = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

interface Fixture {
  readonly workspace: string;
  readonly workspaceRoot: string;
  readonly closureModulesDir: string;
}

/** One workspace plus one closure: an installed package and a local source package. */
function fixture(): Fixture {
  const root = workDir();
  const workspace = join(root, "app");
  const closureModulesDir = join(root, "closure", "node_modules");
  write(join(workspace, "package.json"), "{}\n");
  write(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  // 本地源码包：仓库树里（路径不含 node_modules），靠内容入指纹。
  write(join(root, "vendor", "local-pkg", "package.json"), '{ "name": "local-pkg" }\n');
  write(join(root, "vendor", "local-pkg", "dist", "index.js"), "");
  write(join(closureModulesDir, "local-pkg", "package.json"), '{ "name": "local-pkg" }\n');
  write(join(closureModulesDir, "local-pkg", "dist", "index.js"), "");
  // 安装产物：路径含 node_modules 段，靠文件清单入指纹。
  write(
    join(closureModulesDir, "installed-pkg", "package.json"),
    '{ "name": "installed-pkg", "version": "1.0.0" }\n',
  );
  write(join(closureModulesDir, "installed-pkg", "index.js"), "");
  return { workspace, workspaceRoot: root, closureModulesDir };
}

function fingerprint(input: Fixture): string {
  return seedFingerprint({
    workspace: input.workspace,
    workspaceRoot: input.workspaceRoot,
    entries: ["package.json"],
    closureModulesDir: input.closureModulesDir,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("seed fingerprint", () => {
  it("changes when an installed package gains a file, at an unchanged version", () => {
    const workspace = fixture();
    const before = fingerprint(workspace);

    // 工具侧这次多选了文件进闭包（版本、包名、lockfile 都没变）。
    write(join(workspace.closureModulesDir, "installed-pkg", "index.cjs"), "");

    expect(fingerprint(workspace)).not.toBe(before);

    rmSync(join(workspace.closureModulesDir, "installed-pkg", "index.cjs"));
    expect(fingerprint(workspace)).toBe(before);
  });
});
