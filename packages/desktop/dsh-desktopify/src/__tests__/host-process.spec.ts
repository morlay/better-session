import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DesktopHostProcess } from "../host-process.ts";

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdio: (PassThrough | null)[] = [null, null, null, new PassThrough(), new PassThrough()];
  Object.assign(child, {
    stdio,
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    connected: true,
    kill: () => true,
  });
  return child;
}

function harness(inspectPort?: number): {
  calls: SpawnCall[];
  child: ChildProcess;
  host: DesktopHostProcess;
} {
  const calls: SpawnCall[] = [];
  const child = fakeChild();
  const host = new DesktopHostProcess(
    "/runtime/node/node",
    "/app/seed/profile",
    "/home/profile",
    inspectPort,
    {
      spawn: ((command: string, args: readonly string[], options: { cwd?: string }) => {
        calls.push({ command, args, cwd: options.cwd });
        return child;
      }) as never,
    },
  );
  return { calls, child, host };
}

describe("DesktopHostProcess launch contract", () => {
  it("passes the immutable runtime dir and the profile project, entry from the runtime dir", async () => {
    const { calls, child, host } = harness();
    const ready = host.start();
    child.emit("message", {
      type: "ready",
      protocolVersion: 3,
      dshVersion: "0.1.6-alpha.1",
    });
    await expect(ready).resolves.toMatchObject({ dshVersion: "0.1.6-alpha.1" });

    const call = calls[0];
    expect(call?.command).toBe("/runtime/node/node");
    expect(call?.args).toEqual([
      join(
        "/app/seed/profile",
        "node_modules",
        "@deepseek-ai",
        "dsh-desktop-host",
        "lib",
        "index.js",
      ),
      "/app/seed/profile",
      "/home/profile",
    ]);
    expect(call?.cwd).toBe("/home/profile");
  });

  it("keeps the inspect flag before the entry and links allowed last", async () => {
    const { calls, child, host } = harness(9230);
    const ready = host.start();
    child.emit("message", { type: "ready", protocolVersion: 3, dshVersion: "0.1.6-alpha.1" });
    await ready;

    const call = calls[0];
    expect(call?.args[0]).toBe("--inspect=127.0.0.1:9230");
    expect(call?.args.at(-1)).toBe("--allow-linked-profile");
    expect(call?.args[2]).toBe("/app/seed/profile");
    expect(call?.args[3]).toBe("/home/profile");
  });

  it("surfaces a fatal IPC event as a start failure", async () => {
    const { child, host } = harness();
    const ready = host.start();
    child.emit("message", { type: "fatal", message: "profile bundle missing" });
    await expect(ready).rejects.toThrow(/profile bundle missing/u);
  });
});
