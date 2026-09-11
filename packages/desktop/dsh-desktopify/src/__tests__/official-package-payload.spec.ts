import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyPackageTree } from "../cli/official-deps.ts";

const roots: string[] = [];

function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-desktopify-payload-"));
  roots.push(root);
  return root;
}

function manifest(dir: string, value: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(value, undefined, 2)}\n`);
}

function touch(root: string, ...paths: string[]): void {
  for (const path of paths) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("official package copy", () => {
  it("copies an installation whole, including files outside its files whitelist", () => {
    const root = workDir();
    // 复刻 @img/colour：`main` 不在 `files` 里（npm 打包仍会带上），按白名单裁会裁掉运行期入口。
    const source = join(root, "node_modules", "@img", "colour");
    manifest(source, {
      name: "@img/colour",
      version: "1.1.0",
      main: "index.cjs",
      files: ["color.cjs", "index.d.ts"],
    });
    touch(source, "color.cjs", "index.cjs", "index.d.ts", "README.md", "LICENSE.md");
    manifest(join(source, "node_modules", "nested"), { name: "nested", version: "1.0.0" });
    touch(join(source, "node_modules", "nested"), "index.js");

    const target = join(root, "closure", "@img", "colour");
    copyPackageTree(source, target);

    expect(readdirSync(target).sort()).toEqual([
      "LICENSE.md",
      "README.md",
      "color.cjs",
      "index.cjs",
      "index.d.ts",
      "package.json",
    ]);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });

  it("keeps the files whitelist for a local source package", () => {
    const root = workDir();
    const source = join(root, "vendor", "harness", "packages", "some-pkg");
    manifest(source, { name: "some-pkg", version: "0.0.0", files: ["dist"] });
    touch(source, "dist/index.js", "src/index.ts", "README.md");

    const target = join(root, "closure", "some-pkg");
    copyPackageTree(source, target);

    expect(readdirSync(target).sort()).toEqual(["dist", "package.json"]);
    expect(existsSync(join(target, "src"))).toBe(false);
  });
});
