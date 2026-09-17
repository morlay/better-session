// @vitest-environment jsdom
// 引用渲染：本地引用成官方 chip（icon + token，点击走 actions），外部地址保持锚点，
// 普通文本 / 代码不受影响。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceMarkdown, referenceMentions } from "../reference-markdown.tsx";
import type { Reference } from "../reference.ts";

// vitest 未开 globals，@testing-library/react 的自动清理不会生效，这里显式收尾。
afterEach(cleanup);

const labels = { code: { copyLabel: "copy", copiedLabel: "copied" }, footnotes: "footnotes" };

function actions(): {
  openFile: ReturnType<typeof vi.fn<(path: string) => void>>;
  openSkill: ReturnType<typeof vi.fn<(name: string) => void>>;
} {
  return { openFile: vi.fn<(path: string) => void>(), openSkill: vi.fn<(name: string) => void>() };
}

describe("ReferenceMarkdown", () => {
  it("renders bare URIs as chips (protocol omitted) and clicks through to openFile / openSkill", () => {
    const owner = actions();
    render(
      <ReferenceMarkdown
        text="看 file:mise.toml 与 skill:dsh-side-workspace-plugin-develop"
        labels={labels}
        actions={owner}
      />,
    );
    const file = screen.getByRole("button", { name: "mise.toml" });
    // chip 的 title 是完整引用。
    expect(file.getAttribute("title")).toBe("file:mise.toml");
    fireEvent.click(file);
    expect(owner.openFile).toHaveBeenCalledWith("mise.toml");

    const skill = screen.getByRole("button", { name: "dsh-side-workspace-plugin-develop" });
    fireEvent.click(skill);
    expect(owner.openSkill).toHaveBeenCalledWith("dsh-side-workspace-plugin-develop");
    expect(owner.openFile).toHaveBeenCalledTimes(1);
  });

  it("turns a hand-typed @path into a chip", () => {
    const owner = actions();
    const { container } = render(
      <ReferenceMarkdown text="看 @mise.toml 的配置" labels={labels} actions={owner} />,
    );
    const chip = screen.getByRole("button", { name: "mise.toml" });
    expect(chip.getAttribute("title")).toBe("file:mise.toml");
    fireEvent.click(chip);
    expect(owner.openFile).toHaveBeenCalledWith("mise.toml");
    expect(container.textContent).toBe("看 mise.toml 的配置");
  });

  it("keeps the line fragment of a hand-typed @path on the chip", () => {
    const owner = actions();
    render(<ReferenceMarkdown text="@mise.toml#L12-L40" labels={labels} actions={owner} />);
    const chip = screen.getByRole("button", { name: "mise.toml#L12-L40" });
    expect(chip.getAttribute("title")).toBe("file:mise.toml#L12-L40");
    fireEvent.click(chip);
    expect(owner.openFile).toHaveBeenCalledWith("mise.toml");
  });

  it("turns a local markdown link into a chip showing its label and range", () => {
    const owner = actions();
    const { container } = render(
      <ReferenceMarkdown text="[实现](src/a.ts#L12-L40)" labels={labels} actions={owner} />,
    );
    const chip = screen.getByRole("button", { name: "实现" });
    expect(chip.getAttribute("title")).toBe("file:src/a.ts#L12-L40");
    fireEvent.click(chip);
    // 行号只进 fragment，openFile 拿到的是路径。
    expect(owner.openFile).toHaveBeenCalledWith("src/a.ts");
    expect(container.textContent).toBe("实现");
  });

  it("turns the official mention form into a chip without leaving the @ behind", () => {
    const owner = actions();
    const { container } = render(
      <ReferenceMarkdown text="@[label](dsh-session:abc)" labels={labels} actions={owner} />,
    );
    const chip = screen.getByRole("button", { name: "label" });
    expect(container.textContent).toBe("label");
    // 还没有 dsh-session 的点击目标：渲染但点击无效果。
    expect(() => fireEvent.click(chip)).not.toThrow();
    expect(owner.openFile).not.toHaveBeenCalled();
    expect(owner.openSkill).not.toHaveBeenCalled();
  });

  it("still renders the chip without owner actions", () => {
    render(<ReferenceMarkdown text="file:mise.toml" labels={labels} />);
    const chip = screen.getByRole("button", { name: "mise.toml" });
    expect(() => fireEvent.click(chip)).not.toThrow();
  });

  it("keeps http links as anchors", () => {
    render(<ReferenceMarkdown text="[文档](https://example.com/a)" labels={labels} />);
    const anchor = screen.getByRole("link");
    expect(anchor.getAttribute("href")).toBe("https://example.com/a");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("leaves plain text, inline code and code blocks alone", () => {
    const { container } = render(
      <ReferenceMarkdown
        text={"普通文本 `Makefile`\n\n```\nfile:mise.toml\n```"}
        labels={labels}
        actions={actions()}
      />,
    );
    // 代码块自带官方 copy 按钮，这里只断言没有引用 chip。
    expect(screen.queryAllByRole("button", { name: "mise.toml" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Makefile" })).toHaveLength(0);
    expect(container.textContent).toContain("普通文本 Makefile");
    expect(container.textContent).toContain("file:mise.toml");
  });
});

describe("referenceMentions", () => {
  it("resolves the display text of this render's references", () => {
    const owner = actions();
    const skill: Reference = { protocol: "skill", path: "code-review" };
    const mentions = referenceMentions(owner, new Map([["code-review", skill]]));
    const mention = mentions.resolve("code-review");
    expect(mention?.title).toBe("skill:code-review");
    mention?.open();
    expect(owner.openSkill).toHaveBeenCalledWith("code-review");
  });

  it("resolves explicit scheme tokens and leaves ordinary inline code alone", () => {
    const owner = actions();
    const mentions = referenceMentions(owner);
    const mention = mentions.resolve("file:src/a.ts#L12-L40");
    expect(mention?.title).toBe("file:src/a.ts#L12-L40");
    mention?.open();
    expect(owner.openFile).toHaveBeenCalledWith("src/a.ts");

    expect(mentions.resolve("Makefile")).toBeUndefined();
    expect(mentions.resolve("pnpm install")).toBeUndefined();
    expect(mentions.resolve("src/a.ts#L12-L40")).toBeUndefined();
  });
});
