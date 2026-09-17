// 引用触发的检测逻辑（纯函数）：边界规则、位置、guard 层级与 span 语义。
// 真值来源：上游 @file 词法（`@"…` 未闭合引号 / `@path` 以行首或空白起头）与
// 规格中明确写下的「URL 里的 / 不触发」规则 —— 由本 spec 手算期望值。
import { describe, expect, it } from "vitest";
import { detectTrigger } from "../core/detect.ts";
import type { TriggerGuard } from "../types.ts";

const plain: TriggerGuard = { tier: "plain" };
const claimed: TriggerGuard = { tier: "claimed" };
const frozen: TriggerGuard = { tier: "frozen" };

/** 光标停在 draft 末尾时的检测结果。 */
const atEnd = (draft: string, guard: TriggerGuard = plain) =>
  detectTrigger(draft, draft.length, guard);

describe("detectTrigger 词边界", () => {
  it("行首的 / 与 @ 都触发，位置算 leading", () => {
    expect(atEnd("/go")).toEqual({
      trigger: "/",
      query: "go",
      quoted: false,
      position: "leading",
      span: { start: 0, end: 3, draftRev: 0 },
    });
    expect(atEnd("@wo")).toMatchObject({ trigger: "@", query: "wo", position: "leading" });
  });

  it("空白、换行与标点之后触发；换行之后的 token 算 inline", () => {
    expect(atEnd("say /co")).toMatchObject({ trigger: "/", query: "co", position: "inline" });
    expect(atEnd("see (/go")).toMatchObject({ trigger: "/", query: "go", position: "inline" });
    expect(atEnd("line1\n/go")).toMatchObject({ trigger: "/", query: "go", position: "inline" });
    expect(atEnd("ping @wo")).toMatchObject({ trigger: "@", query: "wo", position: "inline" });
  });

  it("词字符之后不触发：邮箱、相对路径、CJK 紧邻都不算触发位", () => {
    expect(atEnd("user@host")).toBeNull();
    expect(atEnd("a/b")).toBeNull();
    expect(atEnd("foo_1@bar")).toBeNull();
    expect(atEnd("中文@x")).toBeNull();
  });

  it("URL 与盘符里的 / 不触发", () => {
    expect(atEnd("https://example")).toBeNull();
    expect(atEnd("see https://example")).toBeNull();
    expect(atEnd("https://a.b/c/d")).toBeNull();
    expect(atEnd("C:/path")).toBeNull();
  });

  it("冒号不是 scheme 分隔符时 / 照常触发", () => {
    expect(atEnd("note: /go")).toMatchObject({ trigger: "/", query: "go" });
    expect(atEnd(":/go")).toMatchObject({ trigger: "/", query: "go", position: "inline" });
  });

  it("回扫遇到空白即停止：token 之后有空格就没有活跃触发", () => {
    expect(atEnd("/goal x")).toBeNull();
    expect(atEnd("@worker done")).toBeNull();
  });
});

describe("detectTrigger 位置", () => {
  it("前导空白（含换行）之后的首个 token 仍算 leading", () => {
    expect(atEnd("\n\n/goal")).toMatchObject({ trigger: "/", query: "goal", position: "leading" });
    expect(atEnd("  \n /goal")).toMatchObject({ trigger: "/", query: "goal", position: "leading" });
  });

  it("非空白文本之后的 token 算 inline", () => {
    expect(atEnd("a /goal")).toMatchObject({ trigger: "/", query: "goal", position: "inline" });
    expect(atEnd("第一行\n/goal")).toMatchObject({
      trigger: "/",
      query: "goal",
      position: "inline",
    });
  });
});

describe("detectTrigger guard 层级", () => {
  it("claimed 抑制 / 但保留 @", () => {
    expect(atEnd("/co", claimed)).toBeNull();
    expect(atEnd("args /path", claimed)).toBeNull();
    expect(atEnd("/goal @wor", claimed)).toMatchObject({ trigger: "@", query: "wor" });
  });

  it("被抑制的 / 被当作普通字符跳过，继续往左扫", () => {
    expect(detectTrigger("/goal /x", 8, claimed)).toBeNull();
  });

  it("frozen 两个触发符都抑制", () => {
    expect(atEnd("/co", frozen)).toBeNull();
    expect(atEnd("@wo", frozen)).toBeNull();
  });
});

describe("detectTrigger query 与 span", () => {
  it("未闭合的引号 @ 路径跨空格保持活跃", () => {
    const draft = 'read @"docs/design notes';
    expect(atEnd(draft)).toEqual({
      trigger: "@",
      query: "docs/design notes",
      quoted: true,
      position: "inline",
      span: { start: 5, end: draft.length, draftRev: 0 },
    });
  });

  it("span 从触发符到光标，draftRev 由检测层占位", () => {
    expect(detectTrigger("say /goal", 9, plain)?.span).toEqual({ start: 4, end: 9, draftRev: 0 });
    expect(detectTrigger("/goal", 3, plain)).toMatchObject({
      query: "go",
      span: { start: 0, end: 3 },
    });
  });

  it("空 draft 与光标 0 都返回 null", () => {
    expect(detectTrigger("", 0, plain)).toBeNull();
    expect(detectTrigger("/goal", 0, plain)).toBeNull();
  });
});
