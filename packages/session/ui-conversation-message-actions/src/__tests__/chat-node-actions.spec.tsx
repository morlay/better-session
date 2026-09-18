// @vitest-environment jsdom
// 入口门控（ADR-编辑入口不依赖轮次归属）：编辑（撤回）只要求存在可编辑文本块——轮外消息也能撤回；
// 重试只对已闭合轮次开放。两个入口都先弹确认再把操作交给 host。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessageNodeView } from "../client/chat-node/MessageItem.tsx";

afterEach(cleanup);

type RecallSpy = ReturnType<typeof vi.fn<(block: unknown) => Promise<boolean>>>;
type RetrySpy = ReturnType<typeof vi.fn<(turn: number, cascade: string) => Promise<boolean>>>;

const t = ((key: string) => key) as never;

function nodeOf(options: { content?: readonly unknown[]; location?: unknown; anchorSeq?: number }) {
  return {
    key: "user:4",
    kind: "user",
    id: "user-1",
    target: "chat",
    anchorSeq: options.anchorSeq ?? 4,
    visibility: "visible",
    location: options.location ?? closedTurn(),
    data: {
      kind: "user",
      seq: options.anchorSeq ?? 4,
      time: 4,
      content: options.content ?? [{ type: "text", text: "hello" }],
      source: { kind: "user" },
    },
  };
}

function closedTurn(): unknown {
  return { kind: "turn", turn: { turn: 1, status: "closed", steps: [{}] } };
}

function openTurn(): unknown {
  return { kind: "turn", turn: { turn: 1, status: "open", steps: [{}] } };
}

function renderNode(
  node: unknown,
  faces: { recall: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> },
): void {
  // keyed 渲染器的 props 由 slot 面注入：这里只给门控逻辑关心的那几个。
  const View = UserMessageNodeView as unknown as (props: {
    node: unknown;
    renderMessageImages: unknown;
    t: unknown;
    openFile: (path: string) => void;
    openSkill: (name: string) => void;
    recall: unknown;
    retry: unknown;
  }) => ReactNode;
  render(
    <View
      node={node}
      renderMessageImages={() => null}
      t={t}
      openFile={() => {}}
      openSkill={() => {}}
      recall={faces.recall}
      retry={faces.retry}
    />,
  );
}

function faces(): { recall: RecallSpy; retry: RetrySpy } {
  return {
    recall: vi.fn(async (_block: unknown) => true),
    retry: vi.fn(async (_turn: number, _cascade: string) => true),
  };
}

describe("UserMessageNodeView 入口门控", () => {
  it("有文本块的 user 消息：确认后把该块交给 recall", () => {
    const calls = faces();
    renderNode(nodeOf({}), calls);

    fireEvent.click(screen.getByLabelText("编辑"));
    expect(calls.recall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("撤回并编辑"));
    expect(calls.recall).toHaveBeenCalledTimes(1);
    expect(calls.recall.mock.calls[0]?.[0]).toMatchObject({
      kind: "user",
      eventSeq: 4,
      blockIndex: 0,
      text: "hello",
      turn: 1,
    });
    expect(calls.retry).not.toHaveBeenCalled();
  });

  it("无文本块（只有图片）的消息没有编辑入口", () => {
    const calls = faces();
    renderNode(nodeOf({ content: [{ type: "image", attachment: { id: "a" } }] }), calls);

    expect(screen.queryByLabelText("编辑")).toBeNull();
  });

  it("轮外消息（location 无轮次归属）同样可撤回，但不提供重试", () => {
    const calls = faces();
    renderNode(nodeOf({ location: { kind: "session" } }), calls);

    const edit = screen.getByLabelText("编辑");
    expect(screen.queryByLabelText("重试此回合")).toBeNull();

    fireEvent.click(edit);
    fireEvent.click(screen.getByText("撤回并编辑"));
    expect(calls.recall.mock.calls[0]?.[0]).not.toHaveProperty("turn");
  });

  it("重试只对已闭合轮次开放，并带 truncate 级联", () => {
    const closed = faces();
    renderNode(nodeOf({}), closed);
    fireEvent.click(screen.getByLabelText("重试此回合"));
    fireEvent.click(screen.getByText("确认重试"));
    expect(closed.retry).toHaveBeenCalledWith(1, "truncate");

    cleanup();
    const open = faces();
    renderNode(nodeOf({ location: openTurn() }), open);
    expect(screen.queryByLabelText("重试此回合")).toBeNull();
  });
});
