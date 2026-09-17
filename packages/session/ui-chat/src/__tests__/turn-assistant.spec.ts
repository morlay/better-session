// 助手文本提取：只取 text 块并按顺序拼接，思考 / 工具调用 / 图片块不进入正文。
import { describe, expect, it } from "vitest";
import type { AssistantBlock } from "../client/contract/snapshot.ts";
import { assistantText } from "../client/chat/turn-assistant.ts";

function text(value: string): AssistantBlock {
  return { kind: "text", text: value };
}

describe("assistantText", () => {
  it("joins the text blocks in order", () => {
    expect(assistantText([text("前半句"), text("后半句")])).toBe("前半句后半句");
  });

  it("skips blocks that are not text", () => {
    const blocks: readonly AssistantBlock[] = [
      text("答案"),
      { kind: "reasoning", text: "思考" },
      { kind: "tool-call", callId: "c1", name: "bash", argsRaw: "{}" },
      { kind: "image", attachment: { attachmentId: "i1" } } as unknown as AssistantBlock,
      { kind: "other", block: null },
    ];
    expect(assistantText(blocks)).toBe("答案");
  });

  it("keeps the newlines inside one block", () => {
    expect(assistantText([text("第一行\n第二行")])).toBe("第一行\n第二行");
  });

  it("has no text for an empty or text-free message", () => {
    expect(assistantText([])).toBe("");
    expect(assistantText([{ kind: "reasoning", text: "只有思考" }])).toBe("");
  });
});
