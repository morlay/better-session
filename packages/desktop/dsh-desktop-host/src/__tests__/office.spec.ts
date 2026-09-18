import { describe, expect, it } from "vitest";
import * as office from "../office.ts";
import * as workspaceDependencies from "../../../../../vendor/deepseek-harness/apps/desktop-host/src/workspace-dependencies.ts";

interface MountCall {
  readonly plugin: unknown;
  readonly config: unknown;
}

function recordingContext(calls: MountCall[]): never {
  return {
    plugin: async (plugin: unknown, config: unknown) => {
      calls.push({ plugin, config });
    },
  } as never;
}

describe("desktop host office 组合", () => {
  it("挂载随包的工作区依赖，不挂任何 skill provider", async () => {
    const calls: MountCall[] = [];
    const config = {
      source: "/payload/primary-runtime",
      root: "/harness-home/dsh-runtimes/payload",
    };

    await office.apply(recordingContext(calls), config);

    expect(calls.map((call) => (call.plugin as { name?: string }).name)).toEqual([
      "desktop-workspace-dependencies",
    ]);
    expect(calls[0]?.plugin).toBe(workspaceDependencies);
    expect(calls[0]?.config).toBe(config);
  });
});
