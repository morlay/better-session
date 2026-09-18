// @vitest-environment jsdom
// fork 差异点（见本包 .agents/debts/20260917-临时接管上游对话UI的client半.md）：skeleton/InputBar 由我们保留（样式改 css-in-js）。
// 接缝：InputBar 的呈现面——上下文占用按钮跟随上游落在卡片下方的开位行（dock）里，
// 与会话统计同一行；上游说明见 vendor 包 README「Shell 与标准 props」。
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { zh } from "../../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/client/locales.ts";
import { InputBar, type InputBarProps } from "../client/skeleton/InputBar.tsx";

afterEach(cleanup);

const TEMPLATES = zh as unknown as Readonly<Record<string, string>>;

/** 只做 {name} 占位替换的翻译桩；文案模板取自本包 locale。 */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = TEMPLATES[key] ?? key;
  if (params === undefined) return template;
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

const t = translate as unknown as InputBarProps["t"];

const SESSION = { running: false, subagent: null, removed: false, promptError: null };

/** 有压力与容量才渲染圆环：两个字段缺一个，按钮就隐藏。 */
const PROJECTIONS: Readonly<Record<string, unknown>> = {
  contextPressure: { pressureTokens: 450, contextWindow: 1000 },
};

function renderBar(): void {
  const props = {
    useSession: (selector: (state: unknown) => unknown) => selector(SESSION),
    useProjection: (key: string, selector?: (value: unknown) => unknown) =>
      selector === undefined ? PROJECTIONS[key] : selector(PROJECTIONS[key]),
    // dock 里的统计席要 session 输入态才渲染（与上游同一条件），所以给一个最小的 plain 态；
    // keyboard / inputActions 仍缺 → 编辑器走 inert 分支，不起 Lexical。
    useInput: () => ({
      phase: "plain",
      draft: "",
      attachmentIds: [],
      draftRev: 0,
      occurrences: [],
      queue: [],
    }),
    useNotices: () => null,
    useBusyEnter: () => false,
    useLexicon: () => new Map(),
    useMenuLauncher: () => false,
    useFileUploads: () => ({}),
    // 统计行（`conversation.composer.dock` 的实条目）用一个带同样锚点的标记替身：
    // 这一行里的子项顺序与「同级」关系才是接缝，统计本身由它的承载测试管。
    renderSlot: (key: string) =>
      key === "conversation.composer.dock" ? <span data-composer-stats="" /> : null,
    sessionId: "s1",
    variant: "composer",
    t,
  };
  render(<InputBar {...(props as unknown as InputBarProps)} />);
}

describe("InputBar: 上下文占用按钮的位置", () => {
  it("落在卡片下方的 dock 里（跟会话统计同一行），而不是输入卡片内部", () => {
    renderBar();
    const dock = document.querySelector("[data-composer-dock]");
    expect(dock?.querySelector('[aria-haspopup="dialog"]')).not.toBeNull();
    expect(document.querySelector("[data-composer-card] [aria-haspopup='dialog']")).toBeNull();
  });

  it("与统计行是同一行的同级子项，顺序照上游：统计在前、占用按钮在后", () => {
    renderBar();
    const row = [...(document.querySelector("[data-composer-dock]")?.children ?? [])];
    expect(row).toHaveLength(2);
    expect(row[0]?.hasAttribute("data-composer-stats")).toBe(true);
    expect(row[1]?.querySelector('[aria-haspopup="dialog"]')).not.toBeNull();
  });
});
