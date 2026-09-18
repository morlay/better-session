import { describe, expect, it } from "vitest";
import { formatTokens } from "../client/format.ts";

describe("token 数字的紧凑显示", () => {
  it("千以内原样，千/百万/十亿压缩到一位有效小数", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(165)).toBe("165");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(1_250)).toBe("1.3K");
    expect(formatTokens(70_791_946)).toBe("70.8M");
    expect(formatTokens(4_423_575_990)).toBe("4.4B");
  });

  it("非有限值按 0 处理", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-1)).toBe("0");
  });
});
