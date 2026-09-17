export const zh = {
  command: "指令",
  skill: "技能",
  subagent: "子智能体",
  loading: "正在加载…",
  "drill.aria": "进入目录",
  "drill.hint": "进入目录",
  "drill.key": "Tab",
  "crumbs.aria": "目录导航",
  "suggestions.aria": "触发候选建议",
} satisfies Record<string, string>;

export type MenuKey = keyof typeof zh;

export const en = {
  command: "Commands",
  skill: "Skills",
  subagent: "Subagents",
  loading: "Loading…",
  "drill.aria": "Browse folder",
  "drill.hint": "Browse folder",
  "drill.key": "Tab",
  "crumbs.aria": "Folder navigation",
  "suggestions.aria": "Trigger suggestions",
} satisfies Record<MenuKey, string>;
