import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { officialDeploySpecs } from "../cli/official-deps.ts";

const roots: string[] = [];

function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-desktopify-deploy-specs-"));
  roots.push(root);
  return root;
}

function manifest(dir: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(value)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("official deploy specs", () => {
  it("installs registry packages, pins what the workspace lacks, and leaves sources to the walk", () => {
    const root = workDir();
    const workspace = join(root, "app");
    const official = join(workspace, "node_modules", "@deepseek-ai");
    manifest(join(official, "dsh"), { name: "@deepseek-ai/dsh", version: "1.2.3" });
    manifest(join(official, "dsh-bash-local"), {
      name: "@deepseek-ai/dsh-bash-local",
      version: "0.9.0",
    });
    // 解析到源码树的官方包：目录不带 node_modules 段（workspace 链接的 realpath）。
    const source = join(root, "vendor", "dsh-shell");
    manifest(source, { name: "@deepseek-ai/dsh-shell", version: "9.9.9" });
    symlinkSync(source, join(official, "dsh-shell"), "dir");

    const specs = officialDeploySpecs(
      { workspace, workspaceRoot: root, toolRoot: join(root, "tool", "pkg"), dshVersion: "1.2.3" },
      "1.2.3",
    );

    expect(specs["@deepseek-ai/dsh"]).toBe("1.2.3");
    expect(specs["@deepseek-ai/dsh-bash-local"]).toBe("^0.9.0");
    // 工作区没有的官方包（仓库外 app 缺的实验包）：按 app 的目标版本补装。
    expect(specs["@deepseek-ai/dsh-experimental-agent-team"]).toBe("1.2.3");
    // 非 harness 版本化的官方包（cordis-plugin-group 走独立的 1.x 线）：不猜版本。
    expect(specs["@deepseek-ai/cordis-plugin-group"]).toBeUndefined();
    // 源码树的包与工具自带产物不进 deploy 清单（`workspace:` 依赖在 deploy 项目里解析不了）。
    expect(specs["@deepseek-ai/dsh-shell"]).toBeUndefined();
    expect(specs["@deepseek-ai/dsh-desktop-host"]).toBeUndefined();
  });

  it("leaves a workspace-sourced app entirely to the closure walk", () => {
    const root = workDir();

    const specs = officialDeploySpecs(
      {
        workspace: join(root, "app"),
        workspaceRoot: root,
        toolRoot: join(root, "tool", "pkg"),
        dshVersion: "workspace:^",
      },
      "1.2.3",
    );

    expect(specs).toEqual({});
  });
});
