// 消息行的时间 / 耗时 / 速率展示口径：时钟按本地日归属选择形态，
// 耗时与速率按数量级切换精度，秒以下一律截断。
import { describe, expect, it } from "vitest";
import type { ClockTranslate, RunDurationTranslate } from "../client/chat/message-chrome.ts";
import {
  formatLatencySeconds,
  formatMessageClock,
  formatRunDuration,
  formatTokensPerSecond,
  msUntilNextLocalMidnight,
  startOfLocalDay,
} from "../client/chat/message-chrome.ts";

const durationT = ((key: string, params: Record<string, string | number>) => {
  switch (key) {
    case "duration.seconds":
      return `${params.seconds}s`;
    case "duration.minutes":
      return `${params.minutes}m${params.seconds}s`;
    default:
      return `${params.hours}h${params.minutes}m${params.seconds}s`;
  }
}) as unknown as RunDurationTranslate;

const clockT = ((key: string, params: Record<string, number>) =>
  key === "clock.md"
    ? `${params.m}/${params.d}`
    : `${params.y}/${params.m}/${params.d}`) as unknown as ClockTranslate;

describe("startOfLocalDay", () => {
  it("collapses a local timestamp to local midnight", () => {
    const at = new Date(2026, 0, 2, 15, 30, 45, 123).getTime();
    expect(startOfLocalDay(at)).toBe(new Date(2026, 0, 2, 0, 0, 0, 0).getTime());
  });
});

describe("msUntilNextLocalMidnight", () => {
  it("measures the remaining time of the running local day", () => {
    const at = new Date(2026, 0, 2, 15, 0, 0, 0).getTime();
    expect(msUntilNextLocalMidnight(at)).toBe(new Date(2026, 0, 3, 0, 0, 0, 0).getTime() - at);
  });

  it("treats local midnight itself as the start of the next wait", () => {
    const midnight = new Date(2026, 0, 2, 0, 0, 0, 0).getTime();
    expect(msUntilNextLocalMidnight(midnight)).toBe(
      new Date(2026, 0, 3, 0, 0, 0, 0).getTime() - midnight,
    );
  });
});

describe("formatRunDuration", () => {
  it("stays in seconds below one minute", () => {
    expect(formatRunDuration(0, durationT)).toBe("0s");
    expect(formatRunDuration(1500, durationT)).toBe("1s");
    expect(formatRunDuration(59_999, durationT)).toBe("59s");
  });

  it("switches to minutes and pads the seconds at one minute", () => {
    expect(formatRunDuration(60_000, durationT)).toBe("1m00s");
    expect(formatRunDuration(90_000, durationT)).toBe("1m30s");
  });

  it("switches to hours and pads both smaller units", () => {
    expect(formatRunDuration(3_661_000, durationT)).toBe("1h01m01s");
  });

  it("treats a negative duration as zero", () => {
    expect(formatRunDuration(-5_000, durationT)).toBe("0s");
  });
});

describe("formatLatencySeconds", () => {
  it("keeps one decimal below ten seconds", () => {
    expect(formatLatencySeconds(0)).toBe("0");
    expect(formatLatencySeconds(9940)).toBe("9.9");
  });

  it("rounds to whole seconds from ten seconds on", () => {
    expect(formatLatencySeconds(10_400)).toBe("10");
    expect(formatLatencySeconds(12_500)).toBe("13");
  });

  it("treats a negative latency as zero", () => {
    expect(formatLatencySeconds(-100)).toBe("0");
  });
});

describe("formatTokensPerSecond", () => {
  it("keeps one decimal below ten tokens per second", () => {
    expect(formatTokensPerSecond(0)).toBe("0");
    expect(formatTokensPerSecond(9.94)).toBe("9.9");
  });

  it("rounds to whole tokens per second from ten on", () => {
    expect(formatTokensPerSecond(10)).toBe("10");
    expect(formatTokensPerSecond(12.4)).toBe("12");
  });

  it("rounds a value just below ten up into the whole-number form", () => {
    expect(formatTokensPerSecond(9.99)).toBe("10");
  });
});

describe("formatMessageClock", () => {
  const now = new Date(2026, 5, 30, 20, 0, 0, 0).getTime();

  it("shows only the clock for a message from today", () => {
    expect(formatMessageClock(new Date(2026, 5, 30, 9, 5, 0, 0).getTime(), clockT, now)).toBe(
      "09:05",
    );
  });

  it("adds month and day for another day of the same year", () => {
    expect(formatMessageClock(new Date(2026, 5, 1, 9, 5, 0, 0).getTime(), clockT, now)).toBe(
      "6/1 09:05",
    );
  });

  it("adds the year for another year", () => {
    expect(formatMessageClock(new Date(2025, 11, 31, 9, 5, 0, 0).getTime(), clockT, now)).toBe(
      "2025/12/31 09:05",
    );
  });
});
