// @vitest-environment jsdom
// 注册面闭环：nav 行（`sidebar.panellist`）与主面板（`main` keyed）必须用同一个 id 成对注册，
// 否则点击 nav 行会在 layout.selectPanel 的「main 未注册」校验处抛错；行标签来自本包字典。
// slots / locale 是外部框架服务，这里用最小替身记录注册事实——上游 client 半的产物是浏览器
// 模块工厂（window.__ModuleLoader__），node 侧不可加载，真实声明校验在上游包内完成。
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ConversationManagerIcon } from "../client/ConversationManagerIcon.tsx";
import { ConversationManagerPage } from "../client/ConversationManagerPage.tsx";
import { NS, PANEL_ID, PANEL_ORDER, apply, inject } from "../client/index.ts";
import { zh } from "../client/locales.ts";
import { apply as hostApply } from "../index.ts";

afterEach(cleanup);

interface Registration {
  slot: string;
  options: Record<string, unknown>;
  component: unknown;
}

interface Bench {
  ctx: unknown;
  registrations: Registration[];
  injectedSlots: string[];
  effects: string[];
}

function bench(): Bench {
  const registrations: Registration[] = [];
  const injectedSlots: string[] = [];
  const effects: string[] = [];
  const services: Record<string, unknown> = {
    uiWorkspace: { unarchiveSession: vi.fn() },
    sessions: { refresh: vi.fn() },
  };
  const ctx = {
    get: (name: string) => services[name],
    effect: (effect: () => unknown, label: string) => {
      effects.push(label);
      return effect();
    },
    locale: {
      register: vi.fn(),
      bind: () => (key: keyof typeof zh) => zh[key],
    },
    slots: {
      inject: (slot: string, factory: () => unknown) => {
        injectedSlots.push(slot);
        factory();
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ slot: String(options["name"]), options, component });
        return () => {};
      },
    },
    uiWorkspace: services["uiWorkspace"],
  };
  return { ctx, registrations, injectedSlots, effects };
}

describe("ui-conversation-manager 注册面", () => {
  it("host 半保持空 apply", () => {
    expect(hostApply).not.toThrow();
  });

  it("只声明页面用到的服务", () => {
    expect(inject).toEqual(["slots", "locale", "uiWorkspace", "sessions"]);
  });

  it("nav 行与主面板用同一个 id 成对注册", () => {
    const { ctx, registrations, injectedSlots, effects } = bench();
    apply(ctx as never);

    expect(injectedSlots).toEqual(["main", "sidebar.panellist"]);
    expect(effects).toEqual(["ui-conversation-manager: dictionaries"]);

    const page = registrations.find((entry) => entry.slot === "main");
    expect(page?.component).toBe(ConversationManagerPage);
    expect(page?.options["key"]).toBe(PANEL_ID);
    expect(page?.options["locale"]).toBe(NS);

    const row = registrations.find((entry) => entry.slot === "sidebar.panellist");
    expect(row?.component).toBe(ConversationManagerIcon);
    expect(row?.options["id"]).toBe(PANEL_ID);
    expect(row?.options["order"]).toBe(PANEL_ORDER);
    expect(row?.options["locale"]).toBe(NS);
    const label = row?.options["label"] as (() => string) | undefined;
    expect(label).toBeTypeOf("function");
    expect((label as () => string)()).toBe("对话管理");
  });

  it("nav 图标只画字形，不读应用状态", () => {
    const unread = (): never => {
      throw new Error("nav 图标不得读取应用状态");
    };
    // 组件 spec 直喂 props，框架座位的替身由本文件提供。
    const Icon = ConversationManagerIcon as unknown as (
      props: Record<string, unknown>,
    ) => ReactNode;
    const glyph = render(
      <Icon
        size={18}
        active={false}
        usePanelInfo={unread}
        useSessions={unread}
        useSessionStatus={unread}
        useSessionRetainInfo={unread}
        useWorkspaces={unread}
        useResource={unread}
      />,
    );
    expect(glyph.container.querySelector("svg")?.getAttribute("width")).toBe("18");
  });
});
