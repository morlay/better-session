import { mkdir, mkdtemp, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopHost,
  materializeDesktopHost,
  officialClosure,
  officialDependencySpecs,
} from "../cli/official-deps.ts";
import { DESKTOP_HOST_PACKAGE } from "../official.ts";

const TOOL_ROOT = dirname(
  fileURLToPath(import.meta.resolve("@morlay/dsh-desktopify/package.json")),
);
/** 工具自己的依赖副本：部署里落位的载荷只能是它（不是工作区 / vendor 的同名包）。 */
const PAYLOAD = await desktopHost();

const roots: string[] = [];

async function workDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-desktopify-host-"));
  roots.push(root);
  return root;
}

async function plantStaleHost(modulesDir: string): Promise<string> {
  const target = join(modulesDir, ...DESKTOP_HOST_PACKAGE.split("/"));
  await mkdir(join(target, "lib"), { recursive: true });
  await writeFile(join(target, "lib", "index.js"), "// stale copy\n");
  await writeFile(
    join(target, "package.json"),
    `${JSON.stringify({ name: DESKTOP_HOST_PACKAGE, version: "9.9.9" })}\n`,
  );
  return target;
}

function payloadDir(): string {
  if (PAYLOAD === undefined) throw new Error("the tool has no desktop host payload dependency");
  return PAYLOAD.dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop host 载荷", () => {
  it("载荷来自工具的依赖包，入口按 lib/index.js 落位", async () => {
    const dir = payloadDir();

    expect(PAYLOAD?.version).not.toBe("9.9.9");
    expect(dir).toContain("dsh-desktop-host");
    expect((await lstat(join(dir, "lib", "index.js"))).isFile()).toBe(true);
  });

  it("把闭包里已有的旧副本换成工具自己的载荷", async () => {
    const modulesDir = join(await workDir(), "node_modules");
    const stale = await plantStaleHost(modulesDir);

    expect(await materializeDesktopHost(modulesDir)).toBe(stale);

    expect(await readFile(join(stale, "lib", "index.js"), "utf8")).not.toContain("stale copy");
    const manifest = JSON.parse(await readFile(join(stale, "package.json"), "utf8")) as {
      version?: string;
    };
    expect(manifest.version).not.toBe("9.9.9");
  });

  it("把指向别处的载荷链接换成自己的副本", async () => {
    const root = await workDir();
    const modulesDir = join(root, "node_modules");
    const linked = await plantStaleHost(join(root, "workspace-link"));

    await mkdir(join(modulesDir, ...DESKTOP_HOST_PACKAGE.split("/").slice(0, -1)), {
      recursive: true,
    });
    await symlink(linked, join(modulesDir, ...DESKTOP_HOST_PACKAGE.split("/")), "dir");

    const target = await materializeDesktopHost(modulesDir);

    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(linked, "lib", "index.js"), "utf8")).toBe("// stale copy\n");
  });

  it("闭包与 dev 项目的装配都用这个载荷", async () => {
    const input = {
      workspace: TOOL_ROOT,
      workspaceRoot: process.cwd(),
      toolRoot: TOOL_ROOT,
      dshVersion: "workspace:*",
    };

    const closure = await officialClosure(input);
    const specs = await officialDependencySpecs(input);

    expect(closure.get(DESKTOP_HOST_PACKAGE)).toBe(payloadDir());
    expect(specs[DESKTOP_HOST_PACKAGE]).toBe(`link:${payloadDir()}`);
  });
});
