import { describe, expect, it } from "vitest";
import { Token } from "../client/styling/token.ts";
import { dsw } from "../client/theme.ts";

describe("Token", () => {
  it("属性名转 kebab-case，自定义属性原样保留", () => {
    const token = new Token();
    expect(token.prop("WebkitLineClamp")).toBe("-webkit-line-clamp");
    expect(token.prop("--custom")).toBe("--custom");
  });

  it("规范化数字、字符串与组合子值", () => {
    const token = new Token();
    expect(token.normalize(3)).toBe("3");
    expect(token.normalize("1px solid red")).toBe("1px solid red");
    expect(token.normalize(Token.calc<string>`1px + 2px`)).toBe("calc(1px + 2px)");
    expect(token.normalize(undefined)).toBe("");
    expect(token.normalize({})).toBe("");
  });

  it("vars 生成 var() 引用，assignVars 摊平成变量表", () => {
    const vars = Token.vars({ scaling: 1, color: { primary: "#0af" } });
    expect(String(vars.scaling)).toBe("var(--scaling)");
    expect(String(vars.color.primary)).toBe("var(--color-primary)");
    expect(Token.assignVars(vars)).toEqual({ "--color-primary": "#0af", "--scaling": "1" });
    expect(Token.assignVars(vars, { color: { primary: "red" } })).toEqual({
      "--color-primary": "red",
    });
  });

  it("消费官方主题 token：前缀 dsw + 引用 + fallback", () => {
    expect(String(dsw.alias.bg.base)).toBe("var(--dsw-alias-bg-base)");
    expect(String(dsw.static.neutral["100"])).toBe("var(--dsw-static-neutral-100)");
    expect(Token.collect(Token.fallbackVar(dsw.alias.label.primary, "#111"))).toBe(
      "var(--dsw-alias-label-primary, #111)",
    );
  });

  it("variants 生成 data-variant 选择器，colorMix/colorScale 生成可拼接值", () => {
    expect(Token.variants({ solid: { color: "red" } })).toEqual({
      '&[data-variant="solid"]': { color: "red" },
    });
    expect(Token.collect(Token.colorMix<string>`in srgb, red, blue 50%`)).toBe(
      "color-mix(in srgb, red, blue 50%)",
    );
    expect(Token.collect(Token.colorScale("red", { lightness: 0.1 }))).toContain("hsl(from red");
  });
});
