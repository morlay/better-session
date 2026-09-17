import type { InputTriggerCandidate, InputTriggerSource } from "../types.ts";
import type { ExactMatch, MenuReduce, MenuState } from "./contract.ts";

export const MENU_CLOSED: MenuState = {
  open: false,
  hit: null,
  generation: 0,
  groups: [],
  highlight: null,
};

export function seedGroups(
  state: MenuState,
  sources: readonly Pick<InputTriggerSource, "name" | "showGroupTitle">[],
): MenuState {
  return {
    ...state,
    groups: sources.map((source) => ({
      source: source.name,
      ...(source.showGroupTitle === false ? { showGroupTitle: false } : {}),
      status: "pending",
      items: [],
    })),
    highlight: null,
  };
}

const closed = (state: MenuState): MenuState =>
  state.open || state.hit !== null || state.groups.length > 0 || state.highlight !== null
    ? { open: false, hit: null, generation: state.generation, groups: [], highlight: null }
    : state;

function firstHighlight(groups: MenuState["groups"]): MenuState["highlight"] {
  for (const g of groups) {
    if (g.status === "ready" && g.items.length > 0) return { source: g.source, index: 0 };
  }
  return null;
}

function validHighlight(
  highlight: MenuState["highlight"],
  groups: MenuState["groups"],
): MenuState["highlight"] {
  if (!highlight) return null;
  const g = groups.find((x) => x.source === highlight.source);
  return g && g.status === "ready" && highlight.index < g.items.length ? highlight : null;
}

function positions(groups: MenuState["groups"]): { source: string; index: number }[] {
  const out: { source: string; index: number }[] = [];
  for (const g of groups) {
    if (g.status !== "ready") continue;
    for (let i = 0; i < g.items.length; i++) out.push({ source: g.source, index: i });
  }
  return out;
}

const allReadyEmpty = (groups: MenuState["groups"]): boolean =>
  groups.every((g) => g.status === "ready" && g.items.length === 0);

export const menuReduce: MenuReduce = (state, ev) => {
  switch (ev.type) {
    case "hit": {
      if (ev.hit === null) return closed(state);
      return {
        open: true,
        hit: ev.hit,
        generation: state.generation + 1,

        groups: state.groups.map((g) => ({ ...g, status: "pending" })),
        highlight: state.highlight,
      };
    }
    case "source-settled": {
      if (!state.open || ev.generation !== state.generation) return state;
      const idx = state.groups.findIndex((g) => g.source === ev.source);
      if (idx < 0) return state;
      const items: readonly InputTriggerCandidate[] = ev.items ?? [];
      const groups = state.groups.map((g, i) =>
        i === idx ? { ...g, status: "ready" as const, items } : g,
      );
      if (allReadyEmpty(groups)) return closed(state);
      const highlight = validHighlight(state.highlight, groups) ?? firstHighlight(groups);
      return { ...state, groups, highlight };
    }
    case "source-failed": {
      if (!state.open || ev.generation !== state.generation) return state;
      if (!state.groups.some((g) => g.source === ev.source)) return state;
      const groups = state.groups.filter((g) => g.source !== ev.source);
      if (groups.length === 0 || allReadyEmpty(groups)) return closed(state);
      const highlight = validHighlight(state.highlight, groups) ?? firstHighlight(groups);
      return { ...state, groups, highlight };
    }
    case "move": {
      if (!state.open) return state;
      const pos = positions(state.groups);
      if (pos.length === 0) return state;
      const hl = state.highlight;
      const at = hl ? pos.findIndex((p) => p.source === hl.source && p.index === hl.index) : -1;
      const next =
        pos[at < 0 ? (ev.dir === 1 ? 0 : pos.length - 1) : (at + ev.dir + pos.length) % pos.length];
      if (next === undefined) return state;
      if (hl && next.source === hl.source && next.index === hl.index) return state;
      return { ...state, highlight: next };
    }
    case "hover": {
      if (!state.open) return state;
      const target = validHighlight({ source: ev.source, index: ev.index }, state.groups);
      if (target === null) return state;
      const hl = state.highlight;
      if (hl && hl.source === target.source && hl.index === target.index) return state;
      return { ...state, highlight: target };
    }
    case "close":
      return closed(state);
  }
};

export const exactMatch: ExactMatch = (groups, source, name) => {
  const group = groups.find((g) => g.source === source);
  if (!group || group.status !== "ready") return null;
  return group.items.find((c) => c.name === name) ?? null;
};
