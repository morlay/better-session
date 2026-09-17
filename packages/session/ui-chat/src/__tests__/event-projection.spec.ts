// 事件到内容块的投影：上下文来源的形态与生产者标签、消息来源的召回 / skill 名字，
// 内容块与流式 chunk 到渲染块的归一，失败信息的可读化。
import { describe, expect, it } from "vitest";
import type { ContentBlock, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import {
  contextForm,
  contextProducer,
  displayFailure,
  emptyAssistantBlock,
  isTokenDelta,
  sessionRecallLabels,
  skillInvocationName,
  toAssistantBlock,
  toAssistantBlocks,
} from "../client/conversation-nodes/event-projection.ts";

describe("contextForm", () => {
  it("accepts the known injection forms", () => {
    expect(contextForm({ kind: "plugin", form: "recall" })).toBe("recall");
    expect(contextForm({ form: "instructions" })).toBe("instructions");
  });

  it("rejects an unknown or missing form", () => {
    expect(contextForm({ form: "wild" })).toBeNull();
    expect(contextForm({ kind: "plugin" })).toBeNull();
    expect(contextForm(null)).toBeNull();
    expect(contextForm("recall")).toBeNull();
  });
});

describe("contextProducer", () => {
  it("labels a session recall with its reference labels", () => {
    expect(
      contextProducer({
        kind: "session-reference",
        references: [{ label: "第一个" }, { label: "第二个" }],
      }),
    ).toEqual({ role: "recall", label: "第一个, 第二个" });
  });

  it("labels an instruction change with its paths", () => {
    expect(
      contextProducer({
        kind: "agent-instructions",
        changes: [{ path: "AGENTS.md" }, { path: "docs/x.md" }],
      }),
    ).toEqual({ role: "inject", label: "AGENTS.md, docs/x.md" });
  });

  it("labels a plugin injection with the plugin name", () => {
    expect(contextProducer({ kind: "plugin", plugin: "compact" })).toEqual({
      role: "inject",
      label: "compact",
    });
  });

  it("labels a skill invocation with the skill name", () => {
    expect(contextProducer({ kind: "skill-invocation", name: "code-review" })).toEqual({
      role: "inject",
      label: "code-review",
    });
  });

  it("falls back to the raw kind without usable evidence", () => {
    expect(contextProducer({ kind: "session-reference", references: [] })).toEqual({
      role: "recall",
      label: "session-reference",
    });
    expect(contextProducer({ kind: "plugin" })).toEqual({ role: "inject", label: "plugin" });
    expect(contextProducer({ kind: "other-thing" })).toEqual({
      role: "inject",
      label: "other-thing",
    });
    expect(contextProducer(undefined)).toEqual({ role: "inject", label: null });
  });
});

describe("sessionRecallLabels", () => {
  it("collects distinct labels of a session recall", () => {
    expect(
      sessionRecallLabels({
        kind: "session-reference",
        references: [{ label: "a" }, { label: "a" }, {}, { label: 1 }],
      }),
    ).toEqual(["a"]);
  });

  it("has no labels for other sources", () => {
    expect(sessionRecallLabels({ kind: "plugin", references: [{ label: "a" }] })).toEqual([]);
    expect(sessionRecallLabels(null)).toEqual([]);
  });
});

describe("skillInvocationName", () => {
  it("reads the skill name of a skill invocation", () => {
    expect(skillInvocationName({ kind: "skill-invocation", name: "code-review" })).toBe(
      "code-review",
    );
  });

  it("has no name for other sources or an unnamed invocation", () => {
    expect(skillInvocationName({ kind: "skill-invocation" })).toBeNull();
    expect(skillInvocationName({ kind: "plugin", name: "x" })).toBeNull();
  });
});

describe("toAssistantBlock", () => {
  it("maps the renderable content blocks", () => {
    expect(toAssistantBlock({ type: "text", text: "hi" })).toEqual({ kind: "text", text: "hi" });
    expect(toAssistantBlock({ type: "reasoning", text: "why" })).toEqual({
      kind: "reasoning",
      text: "why",
    });
    const image = { type: "image", attachment: { attachmentId: "img" } } as unknown as ContentBlock;
    expect(toAssistantBlock(image)).toEqual({
      kind: "image",
      attachment: { attachmentId: "img" },
    });
    const call = {
      type: "tool-call",
      id: 7,
      name: "bash",
      arguments: '{"cmd":"ls"}',
    } as unknown as ContentBlock;
    expect(toAssistantBlock(call)).toEqual({
      kind: "tool-call",
      callId: "7",
      name: "bash",
      argsRaw: '{"cmd":"ls"}',
    });
  });

  it("keeps an unknown block reachable for the fallback renderer", () => {
    const block = { type: "audio", data: 1 } as unknown as Parameters<typeof toAssistantBlock>[0];
    expect(toAssistantBlock(block)).toEqual({ kind: "other", block });
  });

  it("maps a whole message in order", () => {
    expect(
      toAssistantBlocks([
        { type: "reasoning", text: "why" },
        { type: "text", text: "hi" },
      ] as unknown as Parameters<typeof toAssistantBlocks>[0]),
    ).toEqual([
      { kind: "reasoning", text: "why" },
      { kind: "text", text: "hi" },
    ]);
  });
});

describe("emptyAssistantBlock", () => {
  it("seeds an empty placeholder per streaming block type", () => {
    expect(emptyAssistantBlock("text")).toEqual({ kind: "text", text: "" });
    expect(emptyAssistantBlock("reasoning")).toEqual({ kind: "reasoning", text: "" });
    expect(emptyAssistantBlock("tool-call")).toEqual({
      kind: "tool-call",
      callId: "",
      name: "",
      argsRaw: "",
    });
  });

  it("seeds an empty other block for anything unknown", () => {
    expect(emptyAssistantBlock("audio")).toEqual({ kind: "other", block: null });
  });
});

describe("displayFailure", () => {
  it("keeps code and message of a described failure", () => {
    expect(displayFailure({ code: "RATE_LIMIT", message: "too many" })).toEqual({
      code: "RATE_LIMIT",
      message: "too many",
    });
  });

  it("hides the message of an auth failure", () => {
    expect(displayFailure({ code: "AUTH", message: "bad key" })).toEqual({
      code: "AUTH",
      message: "",
    });
  });

  it("renders a failure without a message as JSON and a non-object as text", () => {
    expect(displayFailure({ code: "X" })).toEqual({
      code: "X",
      message: JSON.stringify({ code: "X" }),
    });
    expect(displayFailure("boom")).toEqual({ message: "boom" });
    expect(displayFailure(null)).toEqual({ message: "null" });
  });
});

describe("isTokenDelta", () => {
  it("counts non-empty text and reasoning deltas", () => {
    expect(isTokenDelta({ type: "text-delta", index: 0, text: "a" } as StreamChunk)).toBe(true);
    expect(isTokenDelta({ type: "reasoning-delta", index: 0, text: "a" } as StreamChunk)).toBe(
      true,
    );
    expect(isTokenDelta({ type: "text-delta", index: 0, text: "" } as StreamChunk)).toBe(false);
  });

  it("counts a tool-call delta with arguments or a name", () => {
    expect(
      isTokenDelta({
        type: "tool-call-delta",
        index: 0,
        id: "c1",
        argumentsDelta: "{}",
      } as StreamChunk),
    ).toBe(true);
    expect(
      isTokenDelta({
        type: "tool-call-delta",
        index: 0,
        id: "c1",
        name: "bash",
        argumentsDelta: "",
      } as StreamChunk),
    ).toBe(true);
    expect(
      isTokenDelta({
        type: "tool-call-delta",
        index: 0,
        id: "c1",
        argumentsDelta: "",
      } as StreamChunk),
    ).toBe(false);
  });

  it("does not count block boundaries or usage", () => {
    expect(isTokenDelta({ type: "block-start", index: 0, blockType: "text" } as StreamChunk)).toBe(
      false,
    );
    expect(isTokenDelta({ type: "finish", reason: { kind: "stop" } } as StreamChunk)).toBe(false);
  });
});
