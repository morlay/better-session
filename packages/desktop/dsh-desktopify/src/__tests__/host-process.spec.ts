import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DesktopHostProcess, type DesktopHostOptions } from "../host-process.ts";

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly stdio: unknown;
}

interface FakeChild extends ChildProcess {
  readonly sent: unknown[];
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    sent: [] as unknown[],
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    connected: true,
    kill: () => true,
    send: (message: unknown, callback?: (error: Error | null) => void) => {
      child.sent.push(message);
      callback?.(null);
      return true;
    },
  });
  return child;
}

function harness(options: DesktopHostOptions = {}, inspectPort?: number) {
  const calls: SpawnCall[] = [];
  const child = fakeChild();
  const host = new DesktopHostProcess(
    "/runtime/node/node",
    "/app/seed/profiles/desktop",
    "/home/profiles/desktop",
    inspectPort,
    {
      ...options,
      spawn: ((command: string, args: readonly string[], spawnOptions: { cwd?: string }) => {
        calls.push({
          command,
          args,
          cwd: spawnOptions.cwd,
          stdio: (spawnOptions as { stdio?: unknown }).stdio,
        });
        return child;
      }) as never,
    },
  );
  return { calls, child, host };
}

const ENTRY = join(
  "/app/seed/profiles/desktop",
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "index.js",
);

describe("DesktopHostProcess launch contract", () => {
  it("runs the bundled host entry in Node mode with the runtime profile argv", async () => {
    const { calls, child, host } = harness({
      primaryRuntime: "/app/runtime/primary-runtime",
      profileResolution: "runtime",
      packageManager: { pnpm: "/app/runtime/pnpm/bin/pnpm.mjs", nodeBin: "/app/runtime/bin" },
    });
    const ready = host.start();
    child.emit("message", {
      type: "ready",
      url: "http://127.0.0.1:19387/?token=abc",
      injections: [{ name: "boot" }],
    });

    await expect(ready).resolves.toEqual({
      url: "http://127.0.0.1:19387/?token=abc",
      injections: [{ name: "boot" }],
    });
    const call = calls[0];
    expect(call?.command).toBe("/runtime/node/node");
    expect(call?.args).toEqual([
      "--expose-internals",
      ENTRY,
      "/app/seed/profiles/desktop",
      "/home/profiles/desktop",
      "/app/runtime/primary-runtime",
      "runtime",
      "/app/runtime/pnpm/bin/pnpm.mjs",
      "/app/runtime/bin",
    ]);
    expect(call?.cwd).toBe("/home/profiles/desktop");
    expect(call?.stdio).toEqual(["ignore", "pipe", "pipe", "ipc"]);
  });

  it("keeps the inspect flag and loader arguments before the entry and links by default", async () => {
    const { calls, child, host } = harness({ nodeArgs: ["--import=tsx/esm"] }, 9230);
    const ready = host.start();
    child.emit("message", { type: "ready", url: "http://127.0.0.1:19387/" });
    await ready;

    const call = calls[0];
    expect(call?.args).toEqual([
      "--expose-internals",
      "--inspect=127.0.0.1:9230",
      "--import=tsx/esm",
      ENTRY,
      "/app/seed/profiles/desktop",
      "/home/profiles/desktop",
      join("/app/seed/profiles/desktop", "..", "runtime", "primary-runtime"),
      "link",
    ]);
  });

  it("passes the caller environment with private launcher variables removed", async () => {
    const previous = process.env.DSH_DESKTOP_SEED_DIR;
    process.env.DSH_DESKTOP_SEED_DIR = "/app/seed";
    try {
      let env: unknown;
      const child = fakeChild();
      const host = new DesktopHostProcess(
        "/runtime/node/node",
        "/app/seed/profiles/desktop",
        "/home/profiles/desktop",
        undefined,
        {
          extraEnv: { DSH_HOME: "/home" },
          spawn: ((_command: string, _args: readonly string[], options: { env?: unknown }) => {
            env = options.env;
            return child;
          }) as never,
        },
      );
      const ready = host.start();
      child.emit("message", { type: "ready", url: "http://127.0.0.1:19387/" });
      await ready;

      const record = env as Record<string, string>;
      expect(record.DSH_HOME).toBe("/home");
      expect(record.DSH_DESKTOP_SEED_DIR).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DSH_DESKTOP_SEED_DIR;
      else process.env.DSH_DESKTOP_SEED_DIR = previous;
    }
  });

  it("surfaces a fatal IPC event as a start failure", async () => {
    const { child, host } = harness();
    const ready = host.start();
    child.emit("message", { type: "fatal", message: "profile bundle missing" });
    await expect(ready).rejects.toThrow(/profile bundle missing/u);
  });

  it("rejects an invalid IPC event", async () => {
    const { child, host } = harness();
    const ready = host.start();
    child.emit("message", { type: "ready" });
    await expect(ready).rejects.toThrow(/invalid IPC event/u);
  });

  it("rejects a shutdown acknowledgement nobody requested", async () => {
    const { child, host } = harness();
    const ready = host.start();
    child.emit("message", { type: "shutdown-complete" });
    await expect(ready).rejects.toThrow(/unrequested shutdown/u);
  });
});

describe("DesktopHostProcess control", () => {
  it("answers update task control requests with the Host result", async () => {
    const { child, host } = harness();
    const ready = host.start();
    child.emit("message", { type: "ready", url: "http://127.0.0.1:19387/" });
    await ready;

    const inspecting = host.updateTasks("inspect");
    const request = child.sent.at(-1) as { type: string; requestId: number; action: string };
    expect(request.type).toBe("update-tasks");
    expect(request.action).toBe("inspect");
    child.emit("message", { type: "update-tasks", requestId: request.requestId, active: true });

    await expect(inspecting).resolves.toBe(true);
  });

  it("reports a failed control request as an error", async () => {
    const { child, host } = harness();
    const ready = host.start();
    child.emit("message", { type: "ready", url: "http://127.0.0.1:19387/" });
    await ready;

    const inspecting = host.updateTasks("lock");
    const request = child.sent.at(-1) as { requestId: number };
    child.emit("message", {
      type: "update-tasks",
      requestId: request.requestId,
      active: true,
      error: "Host is stopping",
    });

    await expect(inspecting).rejects.toThrow(/Host is stopping/u);
  });

  it("requests shutdown and waits for the child to close", async () => {
    const { child, host } = harness();
    const ready = host.start();
    child.emit("message", { type: "ready", url: "http://127.0.0.1:19387/" });
    await ready;

    const stopping = host.stop();
    expect(child.sent).toContainEqual({ type: "shutdown" });
    child.emit("message", { type: "shutdown-complete" });
    child.emit("close", 0);

    await expect(stopping).resolves.toBeUndefined();
  });
});
