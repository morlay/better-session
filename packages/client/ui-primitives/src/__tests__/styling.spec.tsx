// @vitest-environment jsdom
// Styling / styled 的注入行为：规则进 head、按 id 去重、组件带 data-css 属性。
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Styling, styling } from "../client/styling/styling.ts";
import { styled } from "../client/styling/styled.tsx";
import { dsw } from "../client/theme.ts";

describe("Styling", () => {
  it("生成 scoped 规则并把规则写进 head（同一样式复用同一 id）", () => {
    const local = Styling.create();
    const props = local.props({ color: dsw.alias.label.primary, "&:hover": { color: "red" } });
    const [attribute, value] = Object.entries(props)[0] ?? [];
    expect(attribute).toMatch(/^data-css-s[0-9a-z]+$/);
    expect(value).toBe("");

    const id = attribute?.replace("data-css-", "") ?? "";
    const rule = local.sheets().find((sheet) => sheet.startsWith(`[data-css-${id}]`));
    expect(rule).toContain("var(--dsw-alias-label-primary)");
    expect(rule).toContain("&:hover");

    // 同样的样式再次生成：id 稳定，不新增 sheet。
    expect(local.props({ color: dsw.alias.label.primary, "&:hover": { color: "red" } })).toEqual(
      props,
    );
    expect(local.sheets()).toHaveLength(1);
  });

  it("keyframes 返回动画名，injectGlobals 注入全局规则", () => {
    const local = Styling.create();
    const name = local.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
    expect(name).toMatch(/^a[0-9a-z]+$/);
    local.injectGlobals({ ":root": { "--local": "1" } });
    expect(local.sheets().some((sheet) => sheet.startsWith("@keyframes"))).toBe(true);
    expect(local.sheets().some((sheet) => sheet.includes("--local: 1"))).toBe(true);
  });

  it("styled 组件带上 data-css 属性，样式规则出现在文档里", () => {
    const Box = styled("div")({ padding: "4px", color: dsw.alias.label.primary });
    render(<Box data-testid="box">hello</Box>);
    const element = screen.getByTestId("box");
    expect(element.getAttribute("data-css")).toBeNull();
    expect(Object.keys(element.dataset).some((key) => key.startsWith("css"))).toBe(true);
    expect(document.head.textContent).toContain(`padding: 4px`);
    expect(document.head.textContent).toContain("var(--dsw-alias-label-primary)");
  });

  it("className 返回真实类名（供只接受类名的 props），规则同样进 head", () => {
    const local = Styling.create();
    const name = local.className({ color: dsw.alias.label.primary });
    expect(name).toMatch(/^cls-c[0-9a-z]+$/);
    const rule = local.sheets().find((sheet) => sheet.startsWith(`.${name}`));
    expect(rule).toContain("var(--dsw-alias-label-primary)");
    // 条件样式：falsy 跳过；同一份样式返回同一类名。
    expect(local.className({ color: dsw.alias.label.primary })).toBe(name);
    expect(local.className(false, undefined)).toBe("");
  });

  it("单例 styling 供多处复用（不重复注入同一规则）", () => {
    const first = styling.props({ margin: 0 });
    const second = styling.props({ margin: 0 });
    expect(first).toEqual(second);
    expect(document.querySelectorAll(`style[data-css]`).length).toBeGreaterThan(0);
  });
});
