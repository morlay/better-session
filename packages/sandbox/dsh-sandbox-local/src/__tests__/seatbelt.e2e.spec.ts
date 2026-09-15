// 真实内核级验证（darwin-only，自动跳过）：用真装配 + 真 spawn 跑一遍
// workspace-write / allowWrite / deny，证明规则确实进了 Seatbelt profile。
//
// 跳过条件：非 macOS，或宿主不允许 spawn `sandbox-exec`（例如被更外层的
// Seatbelt 拦住，`sandbox_apply: Operation not permitted`）。

import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as plugin from "../index.ts";

/** 宿主是否能真正执行 Seatbelt profile（探测一次）。 */
function seatbeltUsable(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1) (allow default)", "--", "true"],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

const usable = seatbeltUsable();

/** 仓库内、不在 `os.tmpdir()` 下的临时根：allowWrite 的增量效果需要它。 */
const root = join(process.cwd(), ".tmp", "sandbox-local-e2e");
const workspace = join(root, "ws");
const cache = join(root, "cache");

async function mount(config: Record<string, unknown>): Promise<Context> {
  const ctx = new Context();
  ctx.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    workspaceRoot: workspace,
    resolve: (): SandboxExecutionPolicy => ({ mode: "workspace-write", workspaceRoot: workspace }),
    overrideOf: () => undefined,
  } as never);
  await ctx.plugin(plugin, { cwd: workspace, ...config });
  return ctx;
}

/** 用真实平台链 confine，然后真实执行。 */
async function run(
  ctx: Context,
  command: string,
): Promise<{ status: number | null; stderr: string }> {
  const confined = await ctx.sandbox.confine(["bash", "-c", command], {
    mode: "workspace-write",
    workspaceRoot: workspace,
  });
  const [program, ...args] = confined.argv;
  const result = spawnSync(program as string, args, { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe.skipIf(!usable)("真实 Seatbelt 下的 allow / deny", () => {
  const contexts: Context[] = [];

  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(cache, { recursive: true });
    await writeFile(join(workspace, "mise.local.toml"), "TOKEN=secret\n");
    await writeFile(join(workspace, "notes.md"), "hello\n");
    await mkdir(join(workspace, "protected"), { recursive: true });
    await writeFile(join(workspace, "protected", "note.md"), "hello\n");
  });

  afterAll(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("工作区内的普通读写不受影响；deny 文件被内核拒绝读与写", async () => {
    const ctx = await mount({ access: ["-- mise.*.toml"] });
    contexts.push(ctx);

    expect((await run(ctx, `cat ${workspace}/notes.md`)).status).toBe(0);
    expect((await run(ctx, `echo hi > ${workspace}/out.txt`)).status).toBe(0);

    const deniedRead = await run(ctx, `cat ${workspace}/mise.local.toml`);
    expect(deniedRead.status).not.toBe(0);
    expect(deniedRead.stderr).toMatch(/operation not permitted/i);

    const deniedWrite = await run(ctx, `echo x > ${workspace}/mise.local.toml`);
    expect(deniedWrite.status).not.toBe(0);
    expect(deniedWrite.stderr).toMatch(/operation not permitted/i);
  });

  it("r- 条目下读放行、写被内核拒绝", async () => {
    const ctx = await mount({ access: ["r- protected"] });
    contexts.push(ctx);

    expect((await run(ctx, `cat ${workspace}/protected/note.md`)).status).toBe(0);

    const denied = await run(ctx, `echo x > ${workspace}/protected/note.md`);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/operation not permitted/i);
  });

  it("allowWrite 的根真的额外可写，未配置时不可写", async () => {
    const withRules = await mount({ access: [`rw ${cache}`] });
    const withoutRules = await mount({});
    contexts.push(withRules, withoutRules);

    expect((await run(withRules, `echo cached > ${cache}/data.txt`)).status).toBe(0);
    expect((await run(withoutRules, `echo cached > ${cache}/data.txt`)).status).not.toBe(0);
  });
});
