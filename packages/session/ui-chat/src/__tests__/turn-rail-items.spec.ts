// 轮次导航条目：已加载轮次与未加载 outline 合并成一条按轮次升序的道轨，
// 已加载轮次提供锚点并优先提供预览文本，非法 outline 条目一律丢弃。
import { describe, expect, it } from "vitest";
import type { TurnNavigationItem } from "../client/contract/snapshot.ts";
import { mergeTurnRailItems } from "../client/chat/turn-rail-items.ts";

function loaded(overrides: Partial<TurnNavigationItem> & { turn: number }): TurnNavigationItem {
  return { anchorKey: `turn:${overrides.turn}`, prompt: "", response: "", ...overrides };
}

function outlineEntry(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return { turn: 1, seq: 10, prompt: "outline prompt", response: "outline response", ...overrides };
}

describe("mergeTurnRailItems", () => {
  it("has no items without either source", () => {
    expect(mergeTurnRailItems([], []).length).toBe(0);
    expect(mergeTurnRailItems([], undefined).length).toBe(0);
    expect(mergeTurnRailItems([], { turn: 1 }).length).toBe(0);
  });

  it("turns an outline entry into an unloaded anchor", () => {
    const items = mergeTurnRailItems([], [outlineEntry({ turn: 3, seq: 42 })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      turn: 3,
      prompt: "outline prompt",
      response: "outline response",
      anchor: { kind: "unloaded", seq: 42 },
    });
  });

  it("replaces the anchor of a loaded turn while keeping its previews", () => {
    const items = mergeTurnRailItems(
      [loaded({ turn: 1, prompt: "已加载", response: "答案" })],
      [outlineEntry({ turn: 1, seq: 7 })],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      prompt: "已加载",
      response: "答案",
      anchor: { kind: "loaded", key: "turn:1" },
    });
  });

  it("falls back to the outline preview where the loaded turn has none", () => {
    const items = mergeTurnRailItems(
      [loaded({ turn: 1, prompt: "", response: "" })],
      [outlineEntry({ turn: 1, prompt: "outline prompt", response: "outline response" })],
    );
    expect(items[0]).toMatchObject({
      prompt: "outline prompt",
      response: "outline response",
    });
  });

  it("keeps a loaded turn that the outline does not know", () => {
    const items = mergeTurnRailItems(
      [loaded({ turn: 5, prompt: "只有已加载" })],
      [outlineEntry({ turn: 1 })],
    );
    expect(items.map((item) => item.turn)).toEqual([1, 5]);
  });

  it("sorts both sources by turn", () => {
    const items = mergeTurnRailItems(
      [loaded({ turn: 3 }), loaded({ turn: 1 })],
      [outlineEntry({ turn: 4 }), outlineEntry({ turn: 2 })],
    );
    expect(items.map((item) => item.turn)).toEqual([1, 2, 3, 4]);
  });

  it("drops outline entries that are not usable coordinates", () => {
    const items = mergeTurnRailItems(
      [],
      [
        null,
        "turn 1",
        outlineEntry({ turn: -1 }),
        outlineEntry({ turn: 1.5 }),
        outlineEntry({ seq: -1 }),
        outlineEntry({ seq: -0 }),
      ],
    );
    expect(items.length).toBe(0);
  });

  it("defaults a non-string preview to an empty one", () => {
    const items = mergeTurnRailItems([], [outlineEntry({ prompt: 7, response: null })]);
    expect(items[0]).toMatchObject({ prompt: "", response: "" });
  });
});
