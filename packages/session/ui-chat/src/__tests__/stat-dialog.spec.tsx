// @vitest-environment jsdom
// 统计弹层座位：未受控时自己持有开关，受控时把开关交给外部，Escape 关闭。
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStatDialog } from "../client/chat/stat-dialog.ts";

afterEach(cleanup);

function escape(): void {
  fireEvent.keyDown(document, { key: "Escape" });
}

describe("useStatDialog", () => {
  it("owns the open state when it is not controlled", () => {
    const { result } = renderHook(() => useStatDialog());
    expect(result.current.open).toBe(false);

    act(() => {
      result.current.setOpen(true);
    });
    expect(result.current.open).toBe(true);

    act(() => {
      result.current.setOpen(false);
    });
    expect(result.current.open).toBe(false);
  });

  it("follows the controlled open state instead of its own", () => {
    const setOpen = vi.fn<(open: boolean) => void>();
    const { result } = renderHook(() => useStatDialog({ open: true, setOpen }));

    expect(result.current.open).toBe(true);
    result.current.setOpen(false);
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(result.current.open).toBe(true);
  });

  it("closes on Escape while open", () => {
    const { result } = renderHook(() => useStatDialog());
    result.current.setOpen(true);

    escape();
    expect(result.current.open).toBe(false);
  });

  it("ignores Escape while closed", () => {
    const setOpen = vi.fn<(open: boolean) => void>();
    renderHook(() => useStatDialog({ open: false, setOpen }));

    escape();
    expect(setOpen).not.toHaveBeenCalled();
  });
});
