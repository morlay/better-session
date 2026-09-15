// 壳 app 目录的隔离守卫：壳目录落在应用工作区的 node_modules 里，
// electron-builder 会向上找到本仓库根，把仓库依赖树当成壳的运行依赖打进
// app.asar（那些源码树 link: 路径在打包树之外，只能报 cannot find path 后
// 丢弃）。这里锁住随壳目录写下的独立 workspace 文件——它让收集器收敛到壳
// 自身，asar 只剩 `dist/` 与最小 manifest。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../appconfig.ts";
import { prepareShellAppDirectory } from "../cli/electron-builder.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-desktopify-shell-app-"));
  roots.push(root);
  return root;
}

function appConfig(): AppConfig {
  return {
    name: "dsh-custom-next",
    id: "ai.deepseek.dsh.custom-next",
    version: "0.1.5",
    profile: "desktop",
    dshHome: "xdg",
    window: { width: 1280, height: 800, minWidth: 800, minHeight: 600 },
  };
}

describe("prepareShellAppDirectory", () => {
  it("writes a self-contained shell project with an isolating workspace file", () => {
    const appRoot = workDir();
    const buildRoot = workDir();
    mkdirSync(join(appRoot, "dist"), { recursive: true });
    writeFileSync(join(appRoot, "dist", "index.mjs"), "export {};\n");
    writeFileSync(join(appRoot, "dist", "preload.cjs"), "module.exports = {};\n");
    writeFileSync(
      join(appRoot, "package.json"),
      `${JSON.stringify({ name: "@morlay/dsh-desktopify", description: "d", author: "a" })}\n`,
    );

    const appDir = prepareShellAppDirectory({
      appRoot,
      buildRoot,
      appConfig: appConfig(),
      icons: {},
      dir: true,
    });

    // 独立 workspace：`pnpm --workspace-root exec pwd` 收敛到壳目录本身。
    expect(existsSync(join(appDir, "pnpm-workspace.yaml"))).toBe(true);
    expect(readFileSync(join(appDir, "pnpm-workspace.yaml"), "utf8")).toBe("packages: []\n");
    const manifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
      main?: string;
      version?: string;
      dependencies?: unknown;
    };
    expect(manifest.main).toBe("dist/index.mjs");
    expect(manifest.version).toBe("0.1.5");
    expect(manifest.dependencies).toBeUndefined();
    expect(existsSync(join(appDir, "dist", "preload.cjs"))).toBe(true);
  });
});
