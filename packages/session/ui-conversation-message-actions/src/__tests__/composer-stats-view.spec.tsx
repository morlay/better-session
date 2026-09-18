// @vitest-environment jsdom
// 承载组件的可见契约：统计行仍然输出 `data-composer-stats`（与 fork 的 ui-conversation
// 的 InputBar `:has([data-composer-stats])` 底部留白收窄配对），缓存命中读数走我们带的 token 口径。
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StatsPills } from "../client/composer-stats/StatsPills.tsx";

afterEach(cleanup);

// 假 locale：把 key 与参数原样回显，断言只认 key 与口径，不认文案。
function t(key: string, params?: Record<string, unknown>): string {
  if (params === undefined) return key;
  const values = Object.entries(params)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(",");
  return `${key}(${values})`;
}

const View = StatsPills as unknown as (props: {
  useChat: (selector: (snapshot: unknown) => unknown) => unknown;
  useProjection: (key: string) => unknown;
  t: unknown;
}) => ReactNode;

function renderStats(usage: unknown): HTMLElement {
  const { container } = render(
    <View
      useChat={(selector) => selector({ legacy: { nodes: [] } })}
      useProjection={(key) => (key === "tokenUsage" ? usage : undefined)}
      t={t}
    />,
  );
  return container;
}

describe("StatsPills（composer 统计行）", () => {
  it("渲染统计行时带上 data-composer-stats（InputBar 的 :has() 配对靠它）", () => {
    const container = renderStats({
      uncachedInputTokens: 1_000,
      outputTokens: 5,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 0,
    });

    expect(container.querySelector("[data-composer-stats]")).not.toBeNull();
    expect(screen.getByRole("button").textContent).toContain("stats.cacheHit(percent=90)");
  });

  it("全命中读数是 100（越界与等值输入都走这条口径）", () => {
    renderStats({
      uncachedInputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
    });

    expect(screen.getByRole("button").textContent).toContain("stats.cacheHit(percent=100)");
  });

  it("没有 token 活动时不渲染统计行（连 data-composer-stats 也不出）", () => {
    const container = renderStats(undefined);

    expect(container.querySelector("[data-composer-stats]")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
