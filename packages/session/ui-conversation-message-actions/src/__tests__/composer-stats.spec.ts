// composer 统计行的承载面：官方 `ui-chat` 在 `conversation.composer.dock` 注册的 `stats`
// id 由我们以更低优先级（priority -1）覆盖；覆盖的组件必须自带修好的 token 口径
// （越界输入 cacheRead > prompt 不再死循环）。
import type { Context } from "@deepseek-ai/cordis";
import { SlotCore } from "@deepseek-ai/dsh-client-ui-slots";
import { describe, expect, it } from "vitest";
import { StatsPills } from "../client/composer-stats/StatsPills.tsx";
import { registerComposerStats } from "../client/composer-stats/register.ts";
import { formatCacheHitPercent } from "../client/composer-stats/token-format.ts";

// 空根组件：只用来声明子槽，注册面不渲染。
const Dummy = (): null => null;

// 官方 ui-chat 的 stats 行（同 id、默认优先级 0）——覆盖生效后它不应再被渲染。
const officialStats = (): null => null;

// 用例只驱动注册表（声明 → 注册 → 赢家），不渲染组件树，故按注册表的擦除面传入。
function declaredCore(): SlotCore {
  const core = new SlotCore();
  core.register(
    {
      name: "root",
      children: { "conversation.composer.dock": { kind: "list", scope: "session" } },
    } as never,
    Dummy as never,
  );
  core.register(
    { name: "conversation.composer.dock", id: "stats", order: 0, locale: "chat" } as never,
    officialStats as never,
  );
  return core;
}

describe("formatCacheHitPercent", () => {
  it("越界输入（cacheRead 超出 prompt）按全命中返回 100，不死循环", { timeout: 2_000 }, () => {
    expect(formatCacheHitPercent(1_100, 1_000)).toBe("100");
    expect(formatCacheHitPercent(1_100, 1_000, 1)).toBe("100");
    expect(formatCacheHitPercent(1_000, 1)).toBe("100");
  });

  it("正常区间与上游逐值一致（含四舍五入到 100 时展开未命中侧）", () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull();
    expect(formatCacheHitPercent(1_000, 1_000)).toBe("100");
    expect(formatCacheHitPercent(500, 1_000)).toBe("50");
    expect(formatCacheHitPercent(995, 1_000, 1)).toBe("99.5");
    expect(formatCacheHitPercent(999, 1_000)).toBe("99.9");
    expect(formatCacheHitPercent(9_999, 10_000)).toBe("99.99");
  });
});

describe("composer 统计行的槽覆盖", () => {
  it("以 priority -1 覆盖官方 stats id，渲染我们带的组件", () => {
    const core = declaredCore();
    registerComposerStats(core as unknown as Context["slots"]);

    const winners = core.entriesOfSlot("conversation.composer.dock");
    expect(winners.map((entry) => entry.options.id)).toEqual(["stats"]);
    expect(winners[0]?.options.priority).toBe(-1);
    expect(winners[0]?.locale).toBe("chat");
    expect(winners[0]?.component).toBe(StatsPills);
  });

  it("官方 stats 行仍在注册表里但已让位（覆盖是 shadow，不是删除）", () => {
    const core = declaredCore();
    registerComposerStats(core as unknown as Context["slots"]);

    const all = core
      .entries("conversation.composer.dock")
      .filter((entry) => entry.options.id === "stats");
    expect(all).toHaveLength(2);
    expect(all.some((entry) => entry.options.priority === -1)).toBe(true);
  });
});
