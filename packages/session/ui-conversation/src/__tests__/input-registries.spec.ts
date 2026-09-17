// composer 的输入侧登记与策略：草稿阻塞登记、繁忙回车策略、队列读面（纯逻辑）。
import type { SessionFace } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it, vi } from "vitest";
import type { ComposerBlock } from "../client/contract/composer-blocks.ts";
import type { QueuedMessage } from "../client/contract/input.ts";
import { ComposerBlockRegistry } from "../client/input/blocks.ts";
import { queueReadFaceOf } from "../client/input/queue-store.ts";
import {
  ComposerSubmissionPolicy,
  DEFAULT_BUSY_ENTER_BEHAVIOR,
  resolveSubmitMode,
} from "../client/input/submission-policy.ts";
import type { ConversationSettings } from "../submission-settings.ts";

const SID = "s1" as SessionId;

describe("ComposerBlockRegistry", () => {
  it("按会话保存阻塞原因，重复写入相同原因不发布新快照", () => {
    const registry = new ComposerBlockRegistry();
    const store = registry.storeFor(SID);
    const listener = vi.fn();
    store.subscribe(listener);

    registry.set(SID, { reason: "会话不可用" });
    expect(store.getSnapshot()).toEqual({ reason: "会话不可用" });
    expect(listener).toHaveBeenCalledTimes(1);

    registry.set(SID, { reason: "会话不可用" });
    expect(listener).toHaveBeenCalledTimes(1);

    registry.set(SID, { reason: "等待回答" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("清除阻塞后回到未阻塞，忘记会话后重开一张空登记表", () => {
    const registry = new ComposerBlockRegistry();
    registry.set(SID, { reason: "会话不可用" });

    registry.set(SID, undefined);
    expect(registry.storeFor(SID).getSnapshot()).toBeUndefined();

    registry.set(SID, { reason: "会话不可用" });
    registry.forget(SID);
    expect(registry.storeFor(SID).getSnapshot()).toBeUndefined();
  });

  it("不同会话各自持有自己的阻塞状态", () => {
    const registry = new ComposerBlockRegistry();
    const other = "s2" as SessionId;
    registry.set(SID, { reason: "会话不可用" } satisfies ComposerBlock);

    expect(registry.storeFor(other).getSnapshot()).toBeUndefined();
  });
});

describe("resolveSubmitMode: 繁忙时的回车策略", () => {
  it("空闲时一律排队", () => {
    expect(resolveSubmitMode("steer", false, "enter", true)).toBe("queue");
    expect(resolveSubmitMode("queue", false, "accelerated", true)).toBe("queue");
  });

  it("插话通道不可用时一律排队", () => {
    expect(resolveSubmitMode("steer", true, "enter", false)).toBe("queue");
    expect(resolveSubmitMode("steer", true, "accelerated", false)).toBe("queue");
  });

  it("普通回车用用户设的偏好，加速手势用另一侧", () => {
    expect(resolveSubmitMode("steer", true, "enter", true)).toBe("steer");
    expect(resolveSubmitMode("queue", true, "enter", true)).toBe("queue");
    expect(resolveSubmitMode("steer", true, "accelerated", true)).toBe("queue");
    expect(resolveSubmitMode("queue", true, "accelerated", true)).toBe("steer");
  });
});

interface SettingsBench {
  scope: SettingsScope<ConversationSettings>;
  set: ReturnType<typeof vi.fn>;
  push: (section: ConversationSettings | undefined) => void;
}

function settingsBench(initial?: ConversationSettings): SettingsBench {
  let section = initial;
  const listeners = new Set<() => void>();
  const set = vi.fn(async () => true);
  return {
    set,
    push: (next) => {
      section = next;
      for (const listener of listeners) listener();
    },
    scope: {
      getSnapshot: () => ({ value: section }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      set,
    } as unknown as SettingsScope<ConversationSettings>,
  };
}

describe("ComposerSubmissionPolicy", () => {
  it("没有设置宿主时用默认的繁忙行为", () => {
    const policy = new ComposerSubmissionPolicy();
    expect(policy.busyEnter.getSnapshot()).toBe(DEFAULT_BUSY_ENTER_BEHAVIOR);
  });

  it("构造时采纳宿主已保存的行为", () => {
    const policy = new ComposerSubmissionPolicy(settingsBench({ busyEnter: "steer" }).scope);
    expect(policy.busyEnter.getSnapshot()).toBe("steer");
  });

  it("用户改动时写回宿主，重复写同一行为不再写", () => {
    const bench = settingsBench();
    const policy = new ComposerSubmissionPolicy(bench.scope);

    policy.setBusyEnter("steer");
    expect(policy.busyEnter.getSnapshot()).toBe("steer");
    expect(bench.set).toHaveBeenCalledTimes(1);
    expect(bench.set).toHaveBeenCalledWith("busyEnter", "steer");

    policy.setBusyEnter("steer");
    expect(bench.set).toHaveBeenCalledTimes(1);
  });

  it("宿主推送的新行为覆盖本地值", () => {
    const bench = settingsBench({ busyEnter: "queue" });
    const policy = new ComposerSubmissionPolicy(bench.scope);

    bench.push({ busyEnter: "steer" });
    expect(policy.busyEnter.getSnapshot()).toBe("steer");
  });

  it("宿主尚无值时保持当前值", () => {
    const bench = settingsBench({ busyEnter: "steer" });
    const policy = new ComposerSubmissionPolicy(bench.scope);

    bench.push(undefined);
    expect(policy.busyEnter.getSnapshot()).toBe("steer");
  });
});

describe("queueReadFaceOf", () => {
  it("读的是会话快照里的队列，并转发会话订阅", () => {
    const queue: QueuedMessage[] = [{ id: "q1" } as unknown as QueuedMessage];
    let listener: (() => void) | undefined;
    const session = {
      getSnapshot: () => ({ queue }),
      subscribe: (fn: () => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as SessionFace;

    const face = queueReadFaceOf(session);
    expect(face.getSnapshot()).toEqual(queue);

    const observed = vi.fn();
    const off = face.subscribe(observed);
    listener?.();
    expect(observed).toHaveBeenCalledTimes(1);

    off();
    expect(listener).toBeUndefined();
  });
});
