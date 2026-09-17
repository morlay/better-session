// 对话显示模式：跟设置分区同步，用户选择既更新本地面板也写回宿主设置。
import { describe, expect, it, vi } from "vitest";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ChatSettings } from "../chat-settings.ts";
import { TranscriptViewPolicy } from "../client/transcript-view.ts";

type Watcher = () => void;

function hostOf(initial: ChatSettings | undefined): {
  scope: SettingsScope<ChatSettings>;
  set: ReturnType<typeof vi.fn<(field: string, value: unknown) => Promise<void>>>;
  publish: (value: ChatSettings | undefined) => void;
} {
  let value = initial;
  const watchers = new Set<Watcher>();
  const set = vi.fn<(field: string, value: unknown) => Promise<void>>(async () => {});
  const scope = {
    getSnapshot: () => ({ status: "ready", value }),
    subscribe: (listener: Watcher) => {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
    set,
  } as unknown as SettingsScope<ChatSettings>;
  return {
    scope,
    set,
    publish: (next) => {
      value = next;
      for (const listener of watchers) listener();
    },
  };
}

describe("TranscriptViewPolicy", () => {
  it("starts from the mode the settings section carries", () => {
    const host = hostOf({ transcriptView: "normal" });
    const policy = new TranscriptViewPolicy(host.scope);

    expect(policy.mode.getSnapshot()).toBe("normal");
  });

  it("follows the settings section while no explicit choice was made", () => {
    const host = hostOf({ transcriptView: "compact" });
    const policy = new TranscriptViewPolicy(host.scope);

    host.publish({ transcriptView: "normal" });

    expect(policy.mode.getSnapshot()).toBe("normal");
  });

  it("writes an explicit choice back to the settings section", () => {
    const host = hostOf({ transcriptView: "compact" });
    const policy = new TranscriptViewPolicy(host.scope);

    policy.setMode("normal");

    expect(policy.mode.getSnapshot()).toBe("normal");
    expect(host.set).toHaveBeenCalledWith("transcriptView", "normal");
  });

  it("keeps the current mode when the very same choice is made again", () => {
    const host = hostOf({ transcriptView: "normal" });
    const policy = new TranscriptViewPolicy(host.scope);

    policy.setMode("normal");

    expect(host.set).not.toHaveBeenCalled();
  });
});
