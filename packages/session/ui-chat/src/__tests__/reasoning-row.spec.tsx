// @vitest-environment jsdom
// 思考块：折叠时只显示摘要行（运行中取最后一行，否则取第一行，且去掉 ** 标记），
// 点开后显示完整文本。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatViewSlotProps } from "../client/contract/slots.ts";
import { ReasoningRow } from "../client/chat/ReasoningRow.tsx";

afterEach(cleanup);

const t = ((key: string) => key) as unknown as ChatViewSlotProps["t"];

function summaryText(): string | null {
  return document.querySelector("[data-reasoning-summary]")?.textContent ?? null;
}

function row(): HTMLElement {
  const element = document.querySelector("[data-disclosure-row]");
  if (element === null) throw new Error("no disclosure row");
  return element as HTMLElement;
}

describe("ReasoningRow", () => {
  it("collapses a settled block to its first line", () => {
    const { container } = render(
      <ReasoningRow text={"第一行思考\n第二行思考"} running={false} t={t} />,
    );

    expect(summaryText()).toBe("第一行思考");
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("ok");
  });

  it("collapses a running block to its latest line", () => {
    const { container } = render(<ReasoningRow text={"第一行思考\n第二行思考"} running t={t} />);

    expect(summaryText()).toBe("第二行思考");
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("running");
  });

  it("drops the double-asterisk markers from the summary", () => {
    render(<ReasoningRow text={"**加粗**的第一行\n第二行"} running={false} t={t} />);

    expect(summaryText()).toBe("加粗的第一行");
  });

  it("ignores trailing blank lines when picking the running summary", () => {
    render(<ReasoningRow text={"第一行\n\n   "} running t={t} />);

    expect(summaryText()).toBe("第一行");
  });

  it("expands on a row click and collapses again", () => {
    const { container } = render(
      <ReasoningRow text={"第一行思考\n第二行思考"} running={false} t={t} />,
    );

    expect(container.querySelector("[data-expanded]")).toBeNull();
    fireEvent.click(row());
    expect(container.querySelector("[data-expanded]")?.getAttribute("data-expanded")).toBe("true");
    expect(container.textContent).toContain("第二行思考");
    expect(summaryText()).toBeNull();

    fireEvent.click(row());
    expect(container.querySelector("[data-expanded]")).toBeNull();
    expect(summaryText()).toBe("第一行思考");
  });

  it("announces the running state to assistive technology", () => {
    render(<ReasoningRow text={"在想"} running t={t} />);

    expect(screen.getByText("row.running")).toBeTruthy();
  });
});
