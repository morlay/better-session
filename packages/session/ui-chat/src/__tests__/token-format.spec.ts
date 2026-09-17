// Token 数字的展示口径：紧凑计数按数量级换单位、精确计数按三位分组、
// 缓存命中百分比四舍五入到指定位数，四舍五入到 100 但仍有未命中的输入另行展开。
import { describe, expect, it } from "vitest";
import type { ChatViewSlotProps } from "../client/contract/slots.ts";
import {
  formatCacheHitPercent,
  formatExactTokens,
  formatTokens,
} from "../client/chat/token-format.ts";

type Labels = ChatViewSlotProps["t"];

const compactT = ((key: string, params: Record<string, string>) =>
  key === "number.thousand" ? `${params.value}K` : `${params.value}M`) as unknown as Labels;

const groupedT = ((key: string) =>
  key === "number.groupSeparator" ? "," : key) as unknown as Labels;

describe("formatTokens", () => {
  it("leaves values below a thousand unscaled", () => {
    expect(formatTokens(0, compactT)).toBe("0");
    expect(formatTokens(999, compactT)).toBe("999");
  });

  it("uses the thousand unit with one decimal below a hundred", () => {
    expect(formatTokens(1_000, compactT)).toBe("1K");
    expect(formatTokens(1_500, compactT)).toBe("1.5K");
  });

  it("drops the decimal from a hundred units on", () => {
    expect(formatTokens(150_000, compactT)).toBe("150K");
  });

  it("keeps the thousand unit even when it rounds up to a thousand units", () => {
    expect(formatTokens(999_999, compactT)).toBe("1000K");
  });

  it("uses the million unit from a million on", () => {
    expect(formatTokens(1_000_000, compactT)).toBe("1M");
    expect(formatTokens(2_500_000, compactT)).toBe("2.5M");
    expect(formatTokens(1_234_567, compactT)).toBe("1.2M");
  });
});

describe("formatExactTokens", () => {
  it("groups digits by three with the locale separator", () => {
    expect(formatExactTokens(0, groupedT)).toBe("0");
    expect(formatExactTokens(123, groupedT)).toBe("123");
    expect(formatExactTokens(1234, groupedT)).toBe("1,234");
    expect(formatExactTokens(1_234_567, groupedT)).toBe("1,234,567");
  });
});

describe("formatCacheHitPercent", () => {
  it("has no percentage without a prompt", () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull();
  });

  it("reports a full hit as 100", () => {
    expect(formatCacheHitPercent(1_000, 1_000)).toBe("100");
  });

  it("rounds the hit ratio to whole percents", () => {
    expect(formatCacheHitPercent(0, 1_000)).toBe("0");
    expect(formatCacheHitPercent(333, 1_000)).toBe("33");
    expect(formatCacheHitPercent(500, 1_000)).toBe("50");
    expect(formatCacheHitPercent(505, 1_000)).toBe("51");
  });

  it("rounds the hit ratio to tenths on request", () => {
    expect(formatCacheHitPercent(995, 1_000, 1)).toBe("99.5");
    expect(formatCacheHitPercent(333, 1_000, 1)).toBe("33.3");
  });

  it("expands a ratio that rounds to 100 but still missed input", () => {
    expect(formatCacheHitPercent(999, 1_000)).toBe("99.9");
    expect(formatCacheHitPercent(998, 1_000)).toBe("99.8");
    expect(formatCacheHitPercent(9_999, 10_000)).toBe("99.99");
    expect(formatCacheHitPercent(999_999, 1_000_000)).toBe("99.9999");
  });

  it("expands the same way for a ratio that rounds to 100 at one decimal", () => {
    expect(formatCacheHitPercent(999, 1_000, 1)).toBe("99.9");
    expect(formatCacheHitPercent(9_999, 10_000, 1)).toBe("99.99");
  });

  it("accounts for the rounding of the missed side", () => {
    expect(formatCacheHitPercent(1_000, 1_001)).toBe("99.9");
  });

  // 越界输入（cacheRead 超出 prompt）按「全命中」处理：与 cacheRead === prompt 同值（"100"）。
  // 该输入修复前会让未命中侧的展开循环陷入同步死循环，故加 per-test timeout 兜底。
  it("cacheRead 超出 prompt 时不死循环（越界输入钳到 100%）", { timeout: 2000 }, () => {
    expect(formatCacheHitPercent(1_100, 1_000)).toBe("100");
    expect(formatCacheHitPercent(1_100, 1_000, 1)).toBe("100");
    expect(formatCacheHitPercent(1_000, 1)).toBe("100");
  });
});
