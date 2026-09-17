// @vitest-environment jsdom
// user / steering 气泡的呈现差异：文本整体按 raw markdown 渲染（裸 URI 与 @path 成 chip、
// 点击走 openFile / openSkill），多块消息按空行拼回，附件走图片位或文件卡片。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PendingSubmission } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatViewSlotProps } from "../client/contract/slots.ts";
import {
  PendingSteeringBubble,
  PendingSubmissionBubble,
  UserMessageNodeView,
} from "../client/chat/MessageItem.tsx";

afterEach(cleanup);

const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined
    ? key
    : `${key}:${JSON.stringify(params)}`) as unknown as ChatViewSlotProps["t"];

type Faces = {
  openFile: ReturnType<typeof vi.fn<(path: string) => void>>;
  openSkill: ReturnType<typeof vi.fn<(name: string) => void>>;
  renderMessageImages: ReturnType<typeof vi.fn<(props: unknown) => ReactNode>>;
};

function faces(): Faces {
  return {
    openFile: vi.fn<(path: string) => void>(),
    openSkill: vi.fn<(name: string) => void>(),
    renderMessageImages: vi.fn<(props: unknown) => ReactNode>(() => null),
  };
}

function bubbleNode(content: readonly unknown[], kind: "user" | "steering" = "user"): unknown {
  return {
    key: `${kind}:1`,
    kind,
    id: "m1",
    target: "chat",
    anchorSeq: 1,
    visibility: "visible",
    location: { kind: "session" },
    data: {
      kind,
      seq: 1,
      time: new Date(2026, 0, 2, 12, 30, 0, 0).getTime(),
      content,
      source: { kind: "user" },
    },
  };
}

function renderBubble(node: unknown, owner: Faces): { container: HTMLElement } {
  const View = UserMessageNodeView as unknown as (props: {
    node: unknown;
    renderMessageImages: unknown;
    openFile: (path: string) => void;
    openSkill: (name: string) => void;
    t: unknown;
  }) => ReactNode;
  const { container } = render(
    <View
      node={node}
      renderMessageImages={owner.renderMessageImages}
      openFile={owner.openFile}
      openSkill={owner.openSkill}
      t={t}
    />,
  );
  return { container };
}

function textBlock(text: string): unknown {
  return { type: "text", text };
}

describe("UserMessageNodeView", () => {
  it("turns a bare file URI into a chip that opens the file", () => {
    const owner = faces();
    renderBubble(bubbleNode([textBlock("看 file:mise.toml 的配置")]), owner);

    const chip = screen.getByRole("button", { name: "mise.toml" });
    expect(chip.getAttribute("title")).toBe("file:mise.toml");
    fireEvent.click(chip);
    expect(owner.openFile).toHaveBeenCalledWith("mise.toml");
    expect(owner.openSkill).not.toHaveBeenCalled();
  });

  it("turns a skill URI into a chip that opens the skill", () => {
    const owner = faces();
    renderBubble(bubbleNode([textBlock("用 skill:code-review 看看")]), owner);

    fireEvent.click(screen.getByRole("button", { name: "code-review" }));
    expect(owner.openSkill).toHaveBeenCalledWith("code-review");
    expect(owner.openFile).not.toHaveBeenCalled();
  });

  it("turns a hand-typed @path into a chip", () => {
    const owner = faces();
    const { container } = renderBubble(bubbleNode([textBlock("见 @src/a.ts 的实现")]), owner);

    fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(owner.openFile).toHaveBeenCalledWith("src/a.ts");
    expect(container.textContent).toContain("见 src/a.ts 的实现");
  });

  it("keeps the line fragment of a hand-typed @path", () => {
    const owner = faces();
    renderBubble(bubbleNode([textBlock("@src/a.ts#L12-L40 这里")]), owner);

    const chip = screen.getByRole("button", { name: "src/a.ts#L12-L40" });
    expect(chip.getAttribute("title")).toBe("file:src/a.ts#L12-L40");
    fireEvent.click(chip);
    expect(owner.openFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("joins several text blocks into one markdown body", () => {
    const owner = faces();
    const { container } = renderBubble(
      bubbleNode([textBlock("第一段 file:a.ts"), textBlock("第二段 file:b.ts")]),
      owner,
    );

    expect(container.textContent).toContain("第一段");
    expect(container.textContent).toContain("第二段");
    expect(container.textContent?.indexOf("第一段")).toBeLessThan(
      container.textContent?.indexOf("第二段") ?? 0,
    );
    // 两个块拼回同一份 markdown，所以两段里的引用都成 chip。
    expect(screen.getByRole("button", { name: "a.ts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "b.ts" })).toBeTruthy();
  });

  it("renders a file attachment as a card with its name and extension", () => {
    const owner = faces();
    const { container } = renderBubble(
      bubbleNode([{ type: "file", attachment: { name: "report.pdf", bytes: 2048 } }]),
      owner,
    );

    const card = container.querySelector("[data-message-attachments]");
    expect(card?.textContent).toContain("report.pdf");
    expect(card?.textContent).toContain("PDF");
  });

  it("renders image attachments through the image seat and compacts several of them", () => {
    const owner = faces();
    renderBubble(
      bubbleNode([
        { type: "image", attachment: { id: "i1" } },
        { type: "image", attachment: { id: "i2" } },
      ]),
      owner,
    );

    expect(owner.renderMessageImages).toHaveBeenCalledTimes(2);
    expect(owner.renderMessageImages.mock.calls[0]?.[0]).toMatchObject({
      align: "end",
      compact: true,
    });
  });

  it("renders a steering node through the same bubble as a user node", () => {
    const owner = faces();
    renderBubble(bubbleNode([textBlock("改一下 file:a.ts")], "steering"), owner);

    const chip = screen.getByRole("button", { name: "a.ts" });
    fireEvent.click(chip);
    expect(owner.openFile).toHaveBeenCalledWith("a.ts");
    expect(document.querySelector("[data-pending-steering]")).toBeNull();
  });

  it("shows the message clock before the copy action", () => {
    const owner = faces();
    const { container } = renderBubble(bubbleNode([textBlock("你好")]), owner);

    expect(container.textContent).toContain("12:30");
    expect(screen.getByRole("button", { name: "copy" })).toBeTruthy();
  });

  it("renders no bubble body for a message without content", () => {
    const owner = faces();
    const { container } = renderBubble(bubbleNode([]), owner);

    expect(container.querySelector("[data-message-attachments]")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).toContain("12:30");
  });
});

describe("PendingSteeringBubble", () => {
  it("marks the host-authoritative pending steering item", () => {
    const owner = faces();
    const { container } = render(
      <PendingSteeringBubble
        content={[textBlock("等一会 file:a.ts")]}
        renderMessageImages={owner.renderMessageImages as never}
        t={t}
      />,
    );

    expect(container.querySelector("[data-pending-steering]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "a.ts" })).toBeTruthy();
  });
});

describe("PendingSubmissionBubble", () => {
  it("marks a local steering echo with both the echo and the pending marker", () => {
    const owner = faces();
    const { container } = render(
      <PendingSubmissionBubble
        submission={
          {
            requestId: "r1",
            placement: "steering",
            time: new Date(2026, 0, 2, 12, 30, 0, 0).getTime(),
            text: "看 file:a.ts",
            attachments: [],
          } as unknown as PendingSubmission
        }
        renderMessageImages={owner.renderMessageImages as never}
        t={t}
      />,
    );

    const row = container.querySelector("[data-submission-echo]");
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-pending-steering")).toBe("true");
    expect(screen.getByRole("button", { name: "a.ts" })).toBeTruthy();
  });

  it("marks a transcript echo without the pending marker", () => {
    const owner = faces();
    const { container } = render(
      <PendingSubmissionBubble
        submission={
          {
            requestId: "r1",
            placement: "transcript",
            time: new Date(2026, 0, 2, 12, 30, 0, 0).getTime(),
            text: "普通提交",
            attachments: [],
          } as unknown as PendingSubmission
        }
        renderMessageImages={owner.renderMessageImages as never}
        t={t}
      />,
    );

    const row = container.querySelector("[data-submission-echo]");
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-pending-steering")).toBeNull();
  });
});
