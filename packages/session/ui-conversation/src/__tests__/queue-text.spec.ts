import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { queueRowTextOf, queueTextOf } from "../client/queue/queue-text.ts";

describe("queueRowTextOf", () => {
  it("整行都是文本块时给出未截断文本", () => {
    const row = queueRowTextOf([{ type: "text", text: "先跑测试" }] as ContentBlock[]);
    expect(row.text).toBe("先跑测试");
    expect(row.preview).toBe("先跑测试");
  });

  it("混有非文本块时没有文本，预览按 [type] 占位并压空白", () => {
    const row = queueRowTextOf([
      { type: "text", text: "看这个\n  文件" },
      { type: "image" },
      { type: "unknown-block" },
    ] as ContentBlock[]);
    expect(row.text).toBeNull();
    expect(row.preview).toBe("看这个 文件 [unknown-block]");
  });

  it("预览按字符截断到 200 字", () => {
    const row = queueRowTextOf([
      { type: "text", text: "字".repeat(210) },
      { type: "image" },
    ] as ContentBlock[]);
    expect(Array.from(row.preview)).toHaveLength(201);
    expect(row.preview.endsWith("…")).toBe(true);
  });
});

describe("queueTextOf", () => {
  it("优先用未截断文本（整条裸引用都还在）", () => {
    const link = "看 file:src/a.ts#L3-L5 的第 5 行";
    expect(queueTextOf({ text: link, preview: `${link.slice(0, 6)}…` })).toBe(link);
  });

  it("没有未截断文本时回退到预览", () => {
    expect(queueTextOf({ text: null, preview: "看这个 [file]" })).toBe("看这个 [file]");
  });
});
