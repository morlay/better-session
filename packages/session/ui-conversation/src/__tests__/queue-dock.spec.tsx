// @vitest-environment jsdom
// fork 差异点（docs/debt/0001）：队列行渲染 ReferenceMarkdown（裸 URI 成为引用 chip），
// 文本取 queueTextOf（未截断的 text 优先于 preview）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SnapshotSelectorHook } from "@deepseek-ai/dsh-client-ui-slots";
import type { QueueItemId, QueueRow } from "../client/contract/queue.ts";
import { zh } from "../client/locales.ts";
import { QueueDock, type QueueDockProps } from "../client/queue/QueueDock.tsx";

afterEach(cleanup);

const TEMPLATES = zh as unknown as Readonly<Record<string, string>>;
const COPY_KEYS: Readonly<Record<string, string>> = {
  copy: "复制",
  copied: "已复制",
  "markdown.footnotes": "脚注",
};

/** 只做 {name} 占位替换的翻译桩；文案模板取自本包 locale。 */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = COPY_KEYS[key] ?? TEMPLATES[key] ?? key;
  if (params === undefined) return template;
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

const t = translate as unknown as QueueDockProps["t"];

function row(id: string, text: string | null, preview?: string, rpcId?: string): QueueRow {
  return {
    id: id as QueueItemId,
    messageId: `message-${id}`,
    ...(rpcId === undefined ? {} : { rpcId }),
    placement: "queued",
    content: text === null ? [{ type: "text", text: "" }] : [{ type: "text", text }],
    preview: preview ?? (text === null ? "[image]" : text),
    text,
  } as unknown as QueueRow;
}

function sessionOf(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    queue: [],
    running: true,
    subagent: null,
    pendingSubmissions: [],
    ...overrides,
  } as unknown as SessionSnapshot;
}

function renderDock(
  snapshot: SessionSnapshot,
  faces: { updateQueue?: () => Promise<void> } = {},
): { notify: ReturnType<typeof vi.fn>; updateQueue: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const updateQueue = vi.fn(faces.updateQueue ?? (() => Promise.resolve()));
  const props = {
    useSession: ((selector: (state: SessionSnapshot) => unknown) =>
      selector(snapshot)) as unknown as SnapshotSelectorHook<SessionSnapshot>,
    updateQueue,
    notify,
    loadImage: () => Promise.resolve("blob:image"),
    t,
  };
  render(<QueueDock {...(props as unknown as QueueDockProps)} />);
  return { notify, updateQueue };
}

describe("QueueDock: 队列行的文本", () => {
  it("空队列不渲染 dock", () => {
    renderDock(sessionOf());
    expect(document.querySelector("[data-queue-dock]")).toBeNull();
  });

  it("单行队列直接显示行文本，不带计数头部", () => {
    renderDock(sessionOf({ queue: [row("q1", "先跑测试")] }));
    expect(document.querySelector("[data-queue-dock]")).not.toBeNull();
    expect(screen.getByText("先跑测试")).toBeTruthy();
    expect(screen.queryByText("1 条排队消息")).toBeNull();
  });

  it("行内的裸引用渲染成引用 chip 的显示文本，而不是 preview 截断文本", () => {
    renderDock(sessionOf({ queue: [row("q1", "看 file:src/a.ts#L3-L5", "看 file:src/a.t…")] }));
    const dock = document.querySelector("[data-queue-dock]");
    expect(dock?.textContent).toContain("看 src/a.ts#L3-L5");
    expect(dock?.textContent).not.toContain("src/a.t…");
  });

  it("没有未截断文本时回退到 preview", () => {
    renderDock(sessionOf({ queue: [row("q1", null, "看这个 [file]")] }));
    expect(document.querySelector("[data-queue-dock]")?.textContent).toContain("看这个 [file]");
  });
});

describe("QueueDock: 折叠与展开", () => {
  it("多行默认折叠，展开后逐行可见", () => {
    renderDock(sessionOf({ queue: [row("q1", "第一条"), row("q2", "第二条")] }));
    const header = screen.getByRole("button", { name: /2 条排队消息/u });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("第一条")).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("第一条")).toBeTruthy();
    expect(screen.getByText("第二条")).toBeTruthy();
  });
});

describe("QueueDock: 行操作门控", () => {
  it("运行中才可插话发送", () => {
    renderDock(sessionOf({ queue: [row("q1", "排队中")], running: true }));
    expect(screen.getByLabelText("插话发送").hasAttribute("disabled")).toBe(false);

    cleanup();
    renderDock(sessionOf({ queue: [row("q1", "排队中")], running: false }));
    const steer = screen.getByLabelText("插话发送");
    expect(steer.hasAttribute("disabled")).toBe(true);
    expect(steer.getAttribute("title")).toBe("仅运行中可插话发送");
  });

  it("子代理会话的队列只读时不渲染行操作", () => {
    renderDock(
      sessionOf({
        queue: [row("q1", "排队中")],
        subagent: { address: { mode: "snapshot" } },
      } as unknown as Partial<SessionSnapshot>),
    );
    expect(screen.queryByLabelText("删除排队消息")).toBeNull();
    expect(screen.queryByLabelText("编辑排队消息")).toBeNull();
  });

  it("没有文本的行不能编辑，并给出原因", () => {
    renderDock(sessionOf({ queue: [row("q1", null, "[image]")] }));
    const edit = screen.getByLabelText("编辑排队消息");
    expect(edit.hasAttribute("disabled")).toBe(true);
    expect(edit.getAttribute("title")).toBe("包含非文本内容，暂不支持编辑");
  });

  it("删除失败给出错误提示", async () => {
    const { notify } = renderDock(sessionOf({ queue: [row("q1", "排队中")] }), {
      updateQueue: () => Promise.reject(new Error("boom")),
    });
    fireEvent.click(screen.getByLabelText("删除排队消息"));

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith("error", "删除失败：这条消息可能已经开始发送。");
    });
  });

  it("删除成功后调用队列更新并带上 remove 动作", async () => {
    const { updateQueue } = renderDock(sessionOf({ queue: [row("q1", "排队中")] }));
    fireEvent.click(screen.getByLabelText("删除排队消息"));

    await waitFor(() => {
      expect(updateQueue).toHaveBeenCalledWith("q1", { kind: "remove" });
    });
  });
});

describe("QueueDock: 本地提交回显", () => {
  it("尚未被队列接纳的本地提交显示发送中状态", () => {
    renderDock(
      sessionOf({
        pendingSubmissions: [
          { requestId: "r1", placement: "queued", text: "第二条", attachments: [] },
        ],
      } as unknown as Partial<SessionSnapshot>),
    );
    const dock = document.querySelector("[data-queue-dock]");
    expect(dock?.querySelector("[data-submission-echo]")?.textContent).toContain("第二条");
    expect(dock?.textContent).toContain("发送中…");
  });

  it("队列已接纳的本地提交不再重复显示", () => {
    renderDock(
      sessionOf({
        queue: [row("q1", "第一条", "第一条", "r1")],
        pendingSubmissions: [
          { requestId: "r1", placement: "queued", text: "第一条", attachments: [] },
        ],
      } as unknown as Partial<SessionSnapshot>),
    );
    expect(document.querySelector("[data-submission-echo]")).toBeNull();
    expect(document.querySelector("[data-queue-dock]")?.textContent).not.toContain("发送中…");
  });
});
