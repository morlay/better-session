// @vitest-environment jsdom
// 触发候选菜单（组件 props 面）：关闭时不渲染；打开后按 roster 顺序渲染组标题与候选行，
// pending 且无候选的组显示骨架，指针拾取路由回服务面且不抢焦点，高亮通过
// aria-activedescendant / aria-selected 暴露，面包屑头部的当前步骤不可点。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { MenuView } from "../client/MenuView.tsx";
import { zh } from "../client/locales.ts";
import type { MenuState, TriggerHit } from "../core/contract.ts";
import type { InputTriggerCrumb } from "../types.ts";

const hit: TriggerHit = {
  trigger: "/",
  query: "g",
  quoted: false,
  position: "leading",
  span: { start: 0, end: 2, draftRev: 1 },
};

const CLOSED: MenuState = { open: false, hit: null, generation: 0, groups: [], highlight: null };

function openState(partial: Partial<MenuState> = {}): MenuState {
  return {
    open: true,
    hit,
    generation: 1,
    groups: [
      {
        source: "command",
        status: "ready",
        items: [{ name: "goal", description: "Set up a goal", icon: "file" }, { name: "plan" }],
      },
      { source: "skill", status: "pending", items: [] },
    ],
    highlight: { source: "command", index: 0 },
    ...partial,
  };
}

// jsdom 未实现 scrollIntoView：高亮移动时视图会把活动行滚入视野。
const scrollIntoView = vi.fn();
beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 标准 locale seat 的桩：未知键原样返回，和 locale 运行时的 fallback 一致。 */
const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as never;

function mount(
  state: MenuState,
  crumbs: ReadonlyMap<string, readonly InputTriggerCrumb[]> = new Map(),
) {
  const menu = createSnapshotStore<MenuState>(state);
  const headers = createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(crumbs);
  const onPick = vi.fn();
  const onCrumb = vi.fn();
  const onHover = vi.fn();
  const onDismiss = vi.fn();
  const view = render(
    <MenuView
      menu={menu}
      headers={headers}
      onPick={onPick}
      onCrumb={onCrumb}
      onHover={onHover}
      onDismiss={onDismiss}
      t={t}
    />,
  );
  return { menu, headers, onPick, onCrumb, onHover, onDismiss, view };
}

describe("MenuView 打开与关闭", () => {
  it("关闭时不渲染，store 打开后出现候选列表，再次关闭即消失", () => {
    const { menu, view } = mount(CLOSED);
    expect(view.container.childElementCount).toBe(0);
    act(() => {
      menu.set(openState());
    });
    expect(screen.getByRole("listbox", { name: "触发候选建议" })).toBeTruthy();
    act(() => {
      menu.set(CLOSED);
    });
    expect(view.container.childElementCount).toBe(0);
  });

  it("ready 组渲染候选行，pending 且无候选的组渲染两行骨架", () => {
    mount(openState());
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["goalSet up a goal", "plan"]);
    expect(options[0]?.querySelector("svg")).not.toBeNull();
    expect(options[1]?.querySelector("svg")).toBeNull();
    expect(screen.getByRole("status", { name: "正在加载…" }).children).toHaveLength(2);
  });

  it("细化查询期间保留候选的 pending 组显示旧候选，不再显示骨架", () => {
    mount(
      openState({
        groups: [{ source: "command", status: "pending", items: [{ name: "goal" }] }],
        highlight: null,
      }),
    );
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["goal"]);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("MenuView 候选行", () => {
  it("渲染本地化标题、名字别名、组件图标与描述；同 section 只出一个分组标题", () => {
    const Glyph = ({ size = 16 }: { size?: number | undefined }) => (
      <svg data-glyph="plan" width={size} height={size} />
    );
    mount(
      openState({
        groups: [
          {
            source: "command",
            status: "ready",
            items: [
              {
                name: "plan",
                label: "计划",
                description: "进入或退出计划模式",
                icon: Glyph,
                section: "添加",
              },
              { name: "file", label: "File", section: "添加" },
            ],
          },
        ],
      }),
    );
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "计划plan进入或退出计划模式",
      "File",
    ]);
    expect(options[0]?.querySelector('[data-glyph="plan"]')?.getAttribute("width")).toBe("16");
    // label 只是 name 的大小写变体时不渲染别名。
    expect(options[1]?.querySelectorAll("span")).toHaveLength(1);
    expect(screen.getAllByText("添加")).toHaveLength(1);
  });

  it("drill 行的箭头拾取 drill，行体仍是普通拾取，两者都不抢焦点", () => {
    const { onPick } = mount(
      openState({
        groups: [
          {
            source: "reference",
            status: "ready",
            items: [{ name: "src/", drill: true }, { name: "README.md" }],
          },
        ],
        highlight: { source: "reference", index: 0 },
      }),
    );
    const chevron = screen.getByRole("button", { name: "进入目录" });
    expect(fireEvent.mouseDown(chevron)).toBe(false);
    expect(onPick).toHaveBeenCalledWith("reference", 0, "drill");

    const row = screen.getAllByRole("option")[0];
    expect(row).toBeDefined();
    expect(fireEvent.mouseDown(row as HTMLElement)).toBe(false);
    expect(onPick).toHaveBeenCalledWith("reference", 0);
  });

  it("组标题用本地化名，未知源显示原名，空 ready 组不出标题", () => {
    const { view } = mount(
      openState({
        groups: [
          { source: "command", status: "ready", items: [{ name: "goal" }] },
          { source: "hollow", status: "ready", items: [] },
          { source: "mystery", status: "ready", items: [{ name: "x" }] },
          { source: "skill", status: "pending", items: [] },
        ],
      }),
    );
    const titles = [
      ...view.container.querySelectorAll('div[role="presentation"][data-source]'),
    ].map((row) => row.textContent);
    expect(titles).toEqual(["指令", "mystery", "技能"]);
  });

  it("showGroupTitle=false 的源不渲染标题行，但仍显示骨架", () => {
    mount(
      openState({
        groups: [{ source: "reference", showGroupTitle: false, status: "pending", items: [] }],
        highlight: null,
      }),
    );
    expect(screen.queryByText("reference")).toBeNull();
    expect(screen.getByRole("status", { name: "正在加载…" })).toBeTruthy();
  });
});

describe("MenuView 高亮与指针", () => {
  it("高亮通过 aria-activedescendant 与 aria-selected 暴露，无高亮时省略", () => {
    const { menu } = mount(openState({ highlight: { source: "command", index: 1 } }));
    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options[0]?.getAttribute("aria-selected")).toBe("false");

    act(() => {
      menu.set(openState({ highlight: null }));
    });
    expect(screen.getByRole("listbox").getAttribute("aria-activedescendant")).toBeNull();
  });

  it("指针划过候选行路由 hover，已高亮的行不再上报", () => {
    const { onHover } = mount(openState());
    const options = screen.getAllByRole("option");
    fireEvent.mouseMove(options[1] as HTMLElement);
    expect(onHover).toHaveBeenCalledWith("command", 1);
    onHover.mockClear();
    fireEvent.mouseMove(options[0] as HTMLElement);
    expect(onHover).not.toHaveBeenCalled();
  });

  it("高亮移动时把活动行滚入视野", () => {
    const { menu } = mount(openState());
    scrollIntoView.mockClear();
    act(() => {
      menu.set(openState({ highlight: { source: "command", index: 1 } }));
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(screen.getAllByRole("option")[1]);
  });
});

describe("MenuView 面包屑", () => {
  const trail: readonly InputTriggerCrumb[] = [
    { label: "Workspace", value: "root" },
    { label: "src", value: "src", current: true },
  ];

  it("头部渲染在列表之外，当前步骤不可点，其它步骤路由 onCrumb", () => {
    const { onCrumb } = mount(openState(), new Map([["command", trail]]));
    const nav = screen.getByRole("navigation", { name: "目录导航" });
    expect([...nav.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Workspace",
      "src",
    ]);
    expect(screen.getByRole("listbox").contains(nav)).toBe(false);

    const crumbs = nav.querySelectorAll("button");
    expect(fireEvent.mouseDown(crumbs[0] as HTMLElement)).toBe(false);
    expect(onCrumb).toHaveBeenCalledWith("command", 0);
    onCrumb.mockClear();
    expect((crumbs[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.mouseDown(crumbs[1] as HTMLElement);
    expect(onCrumb).not.toHaveBeenCalled();
  });

  it("没有发布 crumbs 的源不渲染头部", () => {
    mount(openState());
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("MenuView 外部指针", () => {
  it("菜单外按下指针请求关闭，菜单内按下不关", () => {
    const { onDismiss } = mount(openState());
    fireEvent.pointerDown(screen.getAllByRole("option")[0] as HTMLElement);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("composer 卡片内的按下不关，卡片外仍关；关闭后监听器移除", () => {
    const menu = createSnapshotStore<MenuState>(openState());
    const onDismiss = vi.fn();
    render(
      <div data-composer-card="">
        <MenuView
          menu={menu}
          headers={createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(
            new Map(),
          )}
          onPick={vi.fn()}
          onCrumb={vi.fn()}
          onHover={vi.fn()}
          onDismiss={onDismiss}
          t={t}
        />
        <button type="button" data-testid="composer-button" />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("composer-button"));
    expect(onDismiss).not.toHaveBeenCalled();

    // 卡片（与菜单）之外则请求关闭。
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // 菜单关闭后指针监听器随之移除。
    act(() => {
      menu.set(CLOSED);
    });
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
