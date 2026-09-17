// 轮次导航项：锚点优先落在该轮的 user 消息上，预览只取可见节点，
// 提问预览压到 50 字以内、回答预览压到 120 字以内。
import { describe, expect, it } from "vitest";
import type { ChatNode } from "../client/contract/chat-nodes.ts";
import type {
  ChatLocationNodeIndex,
  ChatNodeStore,
  TurnNavigationItem,
} from "../client/contract/snapshot.ts";
import {
  sameTurnNavigationItem,
  turnNavigationItem,
} from "../client/conversation-nodes/turn-navigation.ts";

function chatNode(
  key: string,
  kind: "user" | "assistant-step",
  text: string,
  visibility: "visible" | "hidden" = "visible",
): ChatNode {
  const data =
    kind === "user"
      ? {
          kind,
          seq: 1,
          time: 1,
          content: text === "" ? [] : [{ type: "text", text }],
          source: { kind: "user" },
        }
      : { status: "settled", turn: 1, step: 1, blocks: [{ kind: "text", text }], time: 1 };
  return {
    key,
    kind,
    id: key,
    target: "chat",
    anchorSeq: 1,
    location: { kind: "session" },
    visibility,
    data,
  } as unknown as ChatNode;
}

function locations(byTurn: Record<number, readonly string[]>): ChatLocationNodeIndex {
  return { getTurn: (turn) => byTurn[turn] ?? [], getStep: () => [] };
}

function storeOf(nodes: readonly ChatNode[]): ChatNodeStore {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  return {
    get: (key) => byKey.get(key),
    source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    processSource: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
    values: () => [...byKey.values()],
  };
}

describe("turnNavigationItem", () => {
  it("anchors on the user message and previews the prompt", () => {
    const item = turnNavigationItem(
      1,
      locations({ 1: ["u", "a"] }),
      storeOf([chatNode("u", "user", "你好"), chatNode("a", "assistant-step", "回答")]),
    );
    expect(item).toEqual({ turn: 1, anchorKey: "u", prompt: "你好", response: "回答" });
  });

  it("anchors on the first visible node when the turn has no user message", () => {
    const item = turnNavigationItem(
      2,
      locations({ 2: ["a"] }),
      storeOf([chatNode("a", "assistant-step", "回答")]),
    );
    expect(item).toEqual({ turn: 2, anchorKey: "a", prompt: "", response: "回答" });
  });

  it("previews the last assistant step that has text", () => {
    const item = turnNavigationItem(
      1,
      locations({ 1: ["a1", "a2"] }),
      storeOf([
        chatNode("a1", "assistant-step", "第一段"),
        chatNode("a2", "assistant-step", "第二段"),
      ]),
    );
    expect(item?.response).toBe("第二段");
  });

  it("ignores hidden nodes", () => {
    expect(
      turnNavigationItem(
        1,
        locations({ 1: ["a"] }),
        storeOf([chatNode("a", "assistant-step", "回答", "hidden")]),
      ),
    ).toBeUndefined();
  });

  it("has no item for a turn without visible nodes", () => {
    expect(turnNavigationItem(1, locations({}), storeOf([]))).toBeUndefined();
  });

  it("clips the prompt preview just above the limit", () => {
    const store = storeOf([
      chatNode("at-limit", "user", "a".repeat(49)),
      chatNode("above", "user", "b".repeat(50)),
    ]);
    const atLimit = turnNavigationItem(
      1,
      locations({ 1: ["at-limit"] }),
      storeOf([chatNode("at-limit", "user", "a".repeat(49))]),
    );
    const above = turnNavigationItem(1, locations({ 1: ["above"] }), store);
    expect(atLimit?.prompt).toBe("a".repeat(49));
    expect(above?.prompt).toBe(`${"b".repeat(49)}…`);
  });

  it("clips the response preview just above the limit", () => {
    const item = turnNavigationItem(
      1,
      locations({ 1: ["a"] }),
      storeOf([chatNode("a", "assistant-step", "c".repeat(120))]),
    );
    expect(item?.response).toBe(`${"c".repeat(119)}…`);
    expect(item?.response.length).toBe(120);
  });

  it("joins several text blocks with a single space", () => {
    const node = {
      key: "u",
      kind: "user",
      id: "u",
      target: "chat",
      anchorSeq: 1,
      location: { kind: "session" },
      visibility: "visible",
      data: {
        kind: "user",
        seq: 1,
        time: 1,
        content: [
          { type: "text", text: "第一块" },
          { type: "image", attachment: { id: "i" } },
          { type: "text", text: "第二块" },
        ],
        source: { kind: "user" },
      },
    } as unknown as ChatNode;
    const item = turnNavigationItem(1, locations({ 1: ["u"] }), storeOf([node]));
    expect(item?.prompt).toBe("第一块 第二块");
  });

  it("collapses whitespace in a preview", () => {
    const item = turnNavigationItem(
      1,
      locations({ 1: ["u"] }),
      storeOf([chatNode("u", "user", "  第一行\n\n第二行  ")]),
    );
    expect(item?.prompt).toBe("第一行 第二行");
  });
});

describe("sameTurnNavigationItem", () => {
  const base: TurnNavigationItem = { turn: 1, anchorKey: "u", prompt: "问", response: "答" };

  it("treats two absences as equal and one absence as different", () => {
    expect(sameTurnNavigationItem(undefined, undefined)).toBe(true);
    expect(sameTurnNavigationItem(base, undefined)).toBe(false);
  });

  it("compares every displayed field", () => {
    expect(sameTurnNavigationItem(base, { ...base })).toBe(true);
    expect(sameTurnNavigationItem(base, { ...base, prompt: "别的" })).toBe(false);
    expect(sameTurnNavigationItem(base, { ...base, anchorKey: "other" })).toBe(false);
  });
});
