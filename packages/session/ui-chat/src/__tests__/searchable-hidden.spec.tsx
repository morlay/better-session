// @vitest-environment jsdom
// 紧凑模式下被折叠的内容用 until-found 隐藏：浏览器查找唤醒时先展开，
// 焦点落在隐藏内容里也要先展开，避免在不可见处操作。
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSearchableHidden } from "../client/chat/searchable-hidden.ts";

afterEach(cleanup);

function Host({ hidden, reveal }: { hidden: boolean; reveal: () => void }) {
  const ref = useSearchableHidden(hidden, reveal);
  return (
    <div data-testid="target" ref={ref} tabIndex={-1}>
      <button type="button">内容</button>
    </div>
  );
}

function target(container: HTMLElement): HTMLElement {
  const element = container.querySelector('[data-testid="target"]');
  if (element === null) throw new Error("no target element");
  return element as HTMLElement;
}

describe("useSearchableHidden", () => {
  it("hides the element from search-until-found while collapsed", () => {
    const { container } = render(<Host hidden reveal={() => {}} />);

    expect(target(container).getAttribute("hidden")).toBe("until-found");
  });

  it("shows the element again while expanded", () => {
    const { container } = render(<Host hidden={false} reveal={() => {}} />);

    expect(target(container).hasAttribute("hidden")).toBe(false);
  });

  it("reveals instead of hiding when the focus is already inside", () => {
    const reveal = vi.fn<() => void>();
    const { container, rerender } = render(<Host hidden={false} reveal={reveal} />);
    const element = target(container);
    const button = element.querySelector("button");
    button?.focus();

    rerender(<Host hidden reveal={reveal} />);

    expect(container.ownerDocument.activeElement).toBe(button);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(element.hasAttribute("hidden")).toBe(false);
  });

  it("reveals when the browser reports a find-in-page match", () => {
    const reveal = vi.fn<() => void>();
    const { container } = render(<Host hidden reveal={reveal} />);

    target(container).dispatchEvent(new Event("beforematch"));

    expect(reveal).toHaveBeenCalledTimes(1);
  });
});
