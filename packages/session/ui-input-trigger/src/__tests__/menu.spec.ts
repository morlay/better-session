// 菜单归约（纯函数）：一次 hit 一代 generation，源 settle/fail 只影响自己的组，
// 高亮始终落在 ready 且非空的候选上；全空自动关闭。
import { describe, expect, it } from "vitest";
import type { MenuState, TriggerHit } from "../core/contract.ts";
import { MENU_CLOSED, exactMatch, menuReduce, seedGroups } from "../core/menu.ts";

const hit = (query = ""): TriggerHit => ({
  trigger: "/",
  query,
  quoted: false,
  position: "leading",
  span: { start: 0, end: 1 + query.length, draftRev: 1 },
});

const item = (name: string) => ({ name });

function open(names: readonly string[], h: TriggerHit = hit()): MenuState {
  return menuReduce(
    seedGroups(
      MENU_CLOSED,
      names.map((name) => ({ name })),
    ),
    {
      type: "hit",
      hit: h,
    },
  );
}

/** 两个 ready 组：command [goal, model]、skill [commit]。 */
function ready(): MenuState {
  let state = open(["command", "skill"]);
  state = menuReduce(state, {
    type: "source-settled",
    generation: state.generation,
    source: "command",
    items: [item("goal"), item("model")],
  });
  return menuReduce(state, {
    type: "source-settled",
    generation: state.generation,
    source: "skill",
    items: [item("commit")],
  });
}

describe("menuReduce hit", () => {
  it("打开一代新菜单：所有组 pending、无高亮", () => {
    const state = open(["command", "skill"]);
    expect(state).toMatchObject({
      open: true,
      generation: 1,
      groups: [
        { source: "command", status: "pending", items: [] },
        { source: "skill", status: "pending", items: [] },
      ],
      highlight: null,
    });
  });

  it("再次 hit 提升 generation，保留上一代候选与高亮直到新代 settle", () => {
    let state = open(["command"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "command",
      items: [item("goal")],
    });
    state = menuReduce(state, { type: "hit", hit: hit("g") });
    expect(state).toMatchObject({
      generation: 2,
      groups: [{ source: "command", status: "pending", items: [item("goal")] }],
      highlight: { source: "command", index: 0 },
    });
    state = menuReduce(state, {
      type: "source-settled",
      generation: 2,
      source: "command",
      items: [item("greet")],
    });
    expect(state).toMatchObject({
      groups: [{ source: "command", status: "ready", items: [item("greet")] }],
      highlight: { source: "command", index: 0 },
    });
  });

  it("hit(null) 关闭并清空；对已关闭状态按引用不变", () => {
    const closed = menuReduce(open(["command"]), { type: "hit", hit: null });
    expect(closed).toMatchObject({ open: false, hit: null, groups: [], highlight: null });
    expect(menuReduce(closed, { type: "hit", hit: null })).toBe(closed);
  });

  it("showGroupTitle=false 在 hit 与 settle 之间保留", () => {
    let state = menuReduce(
      seedGroups(MENU_CLOSED, [{ name: "reference", showGroupTitle: false }]),
      {
        type: "hit",
        hit: hit(),
      },
    );
    expect(state.groups[0]).toMatchObject({ showGroupTitle: false, status: "pending" });
    state = menuReduce(state, { type: "hit", hit: hit("r") });
    state = menuReduce(state, {
      type: "source-settled",
      generation: 2,
      source: "reference",
      items: [item("README.md")],
    });
    expect(state.groups[0]).toMatchObject({ showGroupTitle: false, status: "ready" });
  });
});

describe("menuReduce source-settled", () => {
  it("把组标记 ready 并高亮第一个候选", () => {
    let state = open(["command", "skill"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "skill",
      items: [item("commit")],
    });
    expect(state.groups[1]).toEqual({ source: "skill", status: "ready", items: [item("commit")] });
    expect(state.groups[0]?.status).toBe("pending");
    expect(state.highlight).toEqual({ source: "skill", index: 0 });
  });

  it("已有有效高亮在后续组 settle 时保留", () => {
    let state = open(["command", "skill"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "skill",
      items: [item("commit")],
    });
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "command",
      items: [item("goal")],
    });
    expect(state.highlight).toEqual({ source: "skill", index: 0 });
  });

  it("省略 items 视为空候选", () => {
    let state = open(["command", "skill"]);
    state = menuReduce(state, { type: "source-settled", generation: 1, source: "command" });
    expect(state.groups[0]).toEqual({ source: "command", status: "ready", items: [] });
    expect(state.open).toBe(true);
  });

  it("陈旧 generation、已关闭状态与未知 source 的 settle 按引用不变", () => {
    let state = open(["command"]);
    state = menuReduce(state, { type: "hit", hit: hit("g") });
    expect(
      menuReduce(state, { type: "source-settled", generation: 1, source: "command", items: [] }),
    ).toBe(state);
    const closed = menuReduce(state, { type: "close" });
    expect(
      menuReduce(closed, { type: "source-settled", generation: 2, source: "command", items: [] }),
    ).toBe(closed);
    expect(
      menuReduce(state, { type: "source-settled", generation: 2, source: "ghost", items: [] }),
    ).toBe(state);
  });

  it("所有组 settle 成空候选时自动关闭", () => {
    let state = open(["command", "skill"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "command",
      items: [],
    });
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "skill",
      items: [],
    });
    expect(state).toMatchObject({ open: false, groups: [], highlight: null });
  });

  it("一组空、另一组有候选时保持打开并高亮有候选的组", () => {
    let state = open(["command", "skill"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "command",
      items: [],
    });
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "skill",
      items: [item("commit")],
    });
    expect(state.open).toBe(true);
    expect(state.highlight).toEqual({ source: "skill", index: 0 });
  });
});

describe("menuReduce source-failed", () => {
  it("静默移除失败的组，并把高亮让给存活组", () => {
    let state = open(["command", "skill"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "command",
      items: [item("goal")],
    });
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "skill",
      items: [item("commit")],
    });
    expect(state.highlight).toEqual({ source: "command", index: 0 });
    state = menuReduce(state, { type: "source-failed", generation: 1, source: "command" });
    expect(state.groups.map((group) => group.source)).toEqual(["skill"]);
    expect(state.highlight).toEqual({ source: "skill", index: 0 });
  });

  it("最后一组失败，或存活组都是空候选时关闭", () => {
    const last = menuReduce(open(["command"]), {
      type: "source-failed",
      generation: 1,
      source: "command",
    });
    expect(last.open).toBe(false);

    let state = open(["command", "skill"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "skill",
      items: [],
    });
    state = menuReduce(state, { type: "source-failed", generation: 1, source: "command" });
    expect(state.open).toBe(false);
  });

  it("陈旧 generation 与未知 source 的失败按引用不变", () => {
    const state = open(["command"]);
    expect(menuReduce(state, { type: "source-failed", generation: 0, source: "command" })).toBe(
      state,
    );
    expect(menuReduce(state, { type: "source-failed", generation: 1, source: "ghost" })).toBe(
      state,
    );
  });
});

describe("menuReduce move", () => {
  it("跨组循环前进并回绕到首项", () => {
    let state = ready();
    state = menuReduce(state, { type: "move", dir: 1 });
    expect(state.highlight).toEqual({ source: "command", index: 1 });
    state = menuReduce(state, { type: "move", dir: 1 });
    expect(state.highlight).toEqual({ source: "skill", index: 0 });
    state = menuReduce(state, { type: "move", dir: 1 });
    expect(state.highlight).toEqual({ source: "command", index: 0 });
  });

  it("向后回绕到末尾；无高亮时从两端进入", () => {
    expect(menuReduce(ready(), { type: "move", dir: -1 }).highlight).toEqual({
      source: "skill",
      index: 0,
    });
    const parked = { ...ready(), highlight: null };
    expect(menuReduce(parked, { type: "move", dir: 1 }).highlight).toEqual({
      source: "command",
      index: 0,
    });
    expect(menuReduce(parked, { type: "move", dir: -1 }).highlight).toEqual({
      source: "skill",
      index: 0,
    });
  });

  it("跳过 pending 组；关闭、无 ready 组或单项时按引用不变", () => {
    let state = open(["command", "skill"]);
    state = menuReduce(state, {
      type: "source-settled",
      generation: 1,
      source: "skill",
      items: [item("commit")],
    });
    expect(menuReduce(state, { type: "move", dir: 1 }).highlight).toEqual({
      source: "skill",
      index: 0,
    });
    expect(menuReduce(open(["command"]), { type: "move", dir: 1 })).toMatchObject({
      highlight: null,
    });
    const closed = menuReduce(ready(), { type: "close" });
    expect(menuReduce(closed, { type: "move", dir: 1 })).toBe(closed);
    let single = open(["command"]);
    single = menuReduce(single, {
      type: "source-settled",
      generation: 1,
      source: "command",
      items: [item("goal")],
    });
    expect(menuReduce(single, { type: "move", dir: 1 })).toBe(single);
  });
});

describe("menuReduce hover", () => {
  it("把高亮停靠到 ready 候选上", () => {
    expect(menuReduce(ready(), { type: "hover", source: "skill", index: 0 }).highlight).toEqual({
      source: "skill",
      index: 0,
    });
  });

  it("非法目标、当前高亮、pending 组与关闭状态都按引用不变", () => {
    const state = ready();
    expect(menuReduce(state, { type: "hover", source: "ghost", index: 0 })).toBe(state);
    expect(menuReduce(state, { type: "hover", source: "command", index: 5 })).toBe(state);
    expect(menuReduce(state, { type: "hover", source: "command", index: 0 })).toBe(state);
    const closed = menuReduce(state, { type: "close" });
    expect(menuReduce(closed, { type: "hover", source: "command", index: 0 })).toBe(closed);

    let pending = open(["command", "skill"]);
    pending = menuReduce(pending, {
      type: "source-settled",
      generation: 1,
      source: "command",
      items: [item("goal")],
    });
    expect(menuReduce(pending, { type: "hover", source: "skill", index: 0 })).toBe(pending);
  });
});

describe("menuReduce close", () => {
  it("清空菜单但保留 generation 供陈旧事件判废", () => {
    const state = menuReduce(open(["command"]), { type: "close" });
    expect(state).toMatchObject({
      open: false,
      hit: null,
      groups: [],
      highlight: null,
      generation: 1,
    });
  });
});

describe("exactMatch", () => {
  const groups: MenuState["groups"] = [
    { source: "command", status: "ready", items: [item("goal"), item("model")] },
    { source: "skill", status: "pending", items: [] },
  ];

  it("只在 ready 组里按 name 精确命中", () => {
    expect(exactMatch(groups, "command", "model")).toEqual(item("model"));
    expect(exactMatch(groups, "command", "goa")).toBeNull();
    expect(exactMatch(groups, "skill", "commit")).toBeNull();
    expect(exactMatch(groups, "ghost", "goal")).toBeNull();
  });
});
