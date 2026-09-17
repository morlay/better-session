import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as plugin from "../index.ts";

const execFileAsync = promisify(execFile);

async function seatbeltUsable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const probe = await capture("/usr/bin/sandbox-exec", [
    "-p",
    "(version 1) (allow default)",
    "--",
    "true",
  ]);
  return probe.status === 0;
}

/** 跑子进程并把非零退出折算成 status，便于与 spawnSync 的结果形状保持一致。 */
async function capture(
  command: string,
  args: string[],
): Promise<{ status: number | null; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(command, args, { encoding: "utf8" });
    return { status: 0, stderr };
  } catch (error: unknown) {
    const failure = error as { code?: unknown; stderr?: unknown };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
}

const usable = await seatbeltUsable();

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

async function run(
  ctx: Context,
  command: string,
): Promise<{ status: number | null; stderr: string }> {
  const confined = await ctx.sandbox.confine(["bash", "-c", command], {
    mode: "workspace-write",
    workspaceRoot: workspace,
  });
  const [program, ...args] = confined.argv;
  return capture(program as string, args);
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
