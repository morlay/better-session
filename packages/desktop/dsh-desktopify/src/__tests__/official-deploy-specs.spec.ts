import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { officialDeploySpecs } from "../cli/official-deps.ts";
import { OFFICIAL_PROFILE_PACKAGES } from "../official-packages.generated.ts";

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
    // 注入面来自生成清单（bundle patch）：用例直接读它挑样本，清单重生成后
    // 仍验证同一组规则，而不是绑死某个包名。
    const dshPackages = OFFICIAL_PROFILE_PACKAGES.filter((name) =>
      name.startsWith("@deepseek-ai/dsh-"),
    );
    const nonHarness = OFFICIAL_PROFILE_PACKAGES.find(
      (name) => !name.startsWith("@deepseek-ai/dsh-"),
    );
    if (dshPackages.length < 3 || nonHarness === undefined) {
      throw new Error("generated official packages list is too small for this fixture");
    }
    const registry = dshPackages[0] as string;
    const sourceTree = dshPackages[1] as string;
    const absent = dshPackages[2] as string;

    const root = workDir();
    const workspace = join(root, "app");
    const official = join(workspace, "node_modules", "@deepseek-ai");
    manifest(join(official, "dsh"), { name: "@deepseek-ai/dsh", version: "1.2.3" });
    manifest(join(official, registry.split("/")[1] as string), {
      name: registry,
      version: "0.9.0",
    });
    // 解析到源码树的官方包：目录不带 node_modules 段（workspace 链接的 realpath）。
    const source = join(root, "vendor", sourceTree.split("/")[1] as string);
    manifest(source, { name: sourceTree, version: "9.9.9" });
    symlinkSync(source, join(official, sourceTree.split("/")[1] as string), "dir");

    const specs = officialDeploySpecs(
      { workspace, workspaceRoot: root, toolRoot: join(root, "tool", "pkg"), dshVersion: "1.2.3" },
      "1.2.3",
    );

    expect(specs["@deepseek-ai/dsh"]).toBe("1.2.3");
    expect(specs[registry]).toBe("^0.9.0");
    // 工作区没有的官方包：按 app 的目标版本补装。
    expect(specs[absent]).toBe("1.2.3");
    // 非 harness 版本化的官方包（cordis 插件线独立版本）：不猜版本。
    expect(specs[nonHarness]).toBeUndefined();
    // 源码树的包与工具自带产物不进 deploy 清单（`workspace:` 依赖在 deploy 项目里解析不了）。
    expect(specs[sourceTree]).toBeUndefined();
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
