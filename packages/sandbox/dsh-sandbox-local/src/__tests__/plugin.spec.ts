import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as plugin from "../index.ts";
import type { ConfigurableSandboxProvider } from "../sandbox.ts";

const contexts: Context[] = [];
let root: string;
let workspace: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-local-spec-")));
  workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
});

async function mount(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    workspaceRoot: workspace,
    resolve: (): SandboxExecutionPolicy => ({ mode: "workspace-write", workspaceRoot: workspace }),
    overrideOf: () => undefined,
  } as never);
  await ctx.plugin(plugin, { cwd: workspace, ...config });
  return ctx;
}

describe("沙箱插件装配", () => {
  it("替换 ctx.sandbox 与 ctx.fs，并保留 sandboxMode 能力事实", async () => {
    const ctx = await mount();
    expect(typeof ctx.sandbox.confine).toBe("function");
    expect(ctx.fs.sandboxMode).toBe("workspace-write");
  });
});

describe("deny 规则", () => {
  it("命中时在 resolve（读入口）拒绝，未命中的目标照常读写", async () => {
    const ctx = await mount({ access: ["-- mise.*.toml", "-- secrets"] });
    await writeFile(join(workspace, "mise.local.toml"), "TOKEN=1");
    await writeFile(join(workspace, "notes.md"), "hi");
    await mkdir(join(workspace, "secrets"));
    await writeFile(join(workspace, "secrets", "token"), "s");

    await expect(ctx.fs.resolve("mise.local.toml", { cwd: workspace })).rejects.toMatchObject({
      code: "FS_SANDBOX_DENIED",
    });
    await expect(ctx.fs.resolve("secrets/token", { cwd: workspace })).rejects.toMatchObject({
      code: "FS_SANDBOX_DENIED",
    });

    const notes = await ctx.fs.resolve("notes.md", { cwd: workspace });
    expect(await ctx.fs.readText(notes)).toBe("hi");
  });

  it("命中时写入也被拒（调用方绕过 resolve 直接给 target 也一样）", async () => {
    const ctx = await mount({ access: ["-- mise.*.toml"] });
    const target = {
      targetKey: join(workspace, "mise.local.toml"),
      displayPath: "mise.local.toml",
    } as FsTarget;
    await expect(ctx.fs.writeText(target, "x")).rejects.toMatchObject({
      code: "FS_SANDBOX_DENIED",
    });
    expect(await readFile(join(workspace, "mise.local.toml"), "utf8").catch(() => "absent")).toBe(
      "absent",
    );
  });

  it("r- 命中时读放行、写入被拒", async () => {
    await writeFile(join(workspace, "mise.local.toml"), "TOKEN=1");
    const ctx = await mount({ access: ["r- mise.local.toml"] });

    const target = await ctx.fs.resolve("mise.local.toml", { cwd: workspace });
    expect(await ctx.fs.readText(target)).toBe("TOKEN=1");
    await expect(ctx.fs.writeText(target, "x")).rejects.toMatchObject({
      code: "FS_SANDBOX_DENIED",
    });
  });

  it("即使策略是 danger-full-access，deny 仍然拒绝", async () => {
    const ctx = await mount({ access: ["-- mise.local.toml"] });
    const target = {
      targetKey: join(workspace, "mise.local.toml"),
      displayPath: "mise.local.toml",
    } as FsTarget;
    await expect(
      ctx.fs.writeText(target, "x", undefined, undefined, {
        mode: "danger-full-access",
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });
  });
});

describe("进程沙箱侧规则", () => {
  it("Seatbelt 方言下把 allowWrite / deny 追加到 profile 末尾", async () => {
    const ctx = await mount({ access: ["rw /cache", "-- mise.*.toml"] });
    const provider = ctx.sandbox as ConfigurableSandboxProvider;
    provider.internals = { chain: ["seatbelt"], seatbeltExec: "/usr/bin/sandbox-exec" };
    const confined = await provider.confine(["bash", "-c", "echo hi"], {
      mode: "workspace-write",
      workspaceRoot: workspace,
    });
    const profile = confined.argv[2] as string;
    expect(confined.argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(profile).toContain('(allow file-write* (subpath "/cache"))');
    expect(profile).toContain(
      `(deny file-read* file-write* (regex #"^${workspace}/mise\\.[^/]*\\.toml$"))`,
    );
  });

  it("read-only 模式不追加 allowWrite，但保留 deny", async () => {
    const ctx = await mount({ access: ["rw /cache", "-- mise.local.toml"] });
    const provider = ctx.sandbox as ConfigurableSandboxProvider;
    provider.internals = { chain: ["seatbelt"], seatbeltExec: "/usr/bin/sandbox-exec" };
    const profile = (
      await provider.confine(["bash", "-c", "echo hi"], {
        mode: "read-only",
        workspaceRoot: workspace,
      })
    ).argv[2] as string;
    expect(profile).not.toContain("/cache");
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${workspace}/mise.local.toml"))`,
    );
  });

  it("空规则时与官方结果逐字一致", async () => {
    const ctx = await mount();
    const provider = ctx.sandbox as ConfigurableSandboxProvider;
    provider.internals = { chain: ["seatbelt"], seatbeltExec: "/usr/bin/sandbox-exec" };
    const profile = (
      await provider.confine(["bash", "-c", "echo hi"], {
        mode: "workspace-write",
        workspaceRoot: workspace,
      })
    ).argv[2] as string;
    expect(profile).not.toContain("(deny file-read*");
    expect(profile).not.toContain('(allow file-write* (subpath "/cache"))');
  });
});
