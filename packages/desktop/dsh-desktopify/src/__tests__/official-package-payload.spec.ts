import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyPackageTree } from "../cli/official-deps.ts";

const roots: string[] = [];

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-payload-"));
  roots.push(root);
  return root;
}

async function manifest(dir: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(value, undefined, 2)}\n`);
}

async function touch(root: string, ...paths: string[]): Promise<void> {
  for (const path of paths) {
    const file = join(root, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "");
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("official package copy", () => {
  it("copies an installation whole, including files outside its files whitelist", async () => {
    const root = await workDir();

    const source = join(root, "node_modules", "@img", "colour");
    await manifest(source, {
      name: "@img/colour",
      version: "1.1.0",
      main: "index.cjs",
      files: ["color.cjs", "index.d.ts"],
    });
    await touch(source, "color.cjs", "index.cjs", "index.d.ts", "README.md", "LICENSE.md");
    await manifest(join(source, "node_modules", "nested"), { name: "nested", version: "1.0.0" });
    await touch(join(source, "node_modules", "nested"), "index.js");

    const target = join(root, "closure", "@img", "colour");
    await copyPackageTree(source, target);

    expect((await readdir(target)).sort()).toEqual([
      "LICENSE.md",
      "README.md",
      "color.cjs",
      "index.cjs",
      "index.d.ts",
      "package.json",
    ]);
    expect(await exists(join(target, "node_modules"))).toBe(false);
  });

  it("keeps the files whitelist for a local source package", async () => {
    const root = await workDir();
    const source = join(root, "vendor", "harness", "packages", "some-pkg");
    await manifest(source, { name: "some-pkg", version: "0.0.0", files: ["dist"] });
    await touch(source, "dist/index.js", "src/index.ts", "README.md");

    const target = join(root, "closure", "some-pkg");
    await copyPackageTree(source, target);

    expect((await readdir(target)).sort()).toEqual(["dist", "package.json"]);
    expect(await exists(join(target, "src"))).toBe(false);
  });
});
