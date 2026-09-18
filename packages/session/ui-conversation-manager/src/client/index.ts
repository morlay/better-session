// 「对话管理」页面：nav 行（sidebar.panellist）与主面板（main keyed）用同一个 id 成对
// 注册；点击 nav 行经 ctx.layout.selectPanel 校验该 id 在 main 里已注册。
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import { ConversationManagerController } from "./controller.ts";
import { ConversationManagerPage } from "./ConversationManagerPage.tsx";
import { ConversationManagerIcon } from "./ConversationManagerIcon.tsx";
import { en, zh, type ConversationManagerKey } from "./locales.ts";

export type { ConversationManagerFace, ConversationManagerPorts } from "./controller.ts";
export { ConversationManagerController, ConversationManagerRequestError } from "./controller.ts";
export type { ConversationManagerIconProps } from "./ConversationManagerIcon.tsx";
export type { ConversationManagerPageProps } from "./ConversationManagerPage.tsx";
export type { ConversationManagerKey } from "./locales.ts";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    conversationManager: ConversationManagerKey;
  }
}

/** 本包字典的 namespace。 */
export const NS = "conversationManager";

/** nav 行与主面板共用的 id。 */
export const PANEL_ID = "conversations" as MainPanelId;

/** nav 行的位置：紧邻官方 Plugins 行（order 0）。 */
export const PANEL_ORDER = 1;

/** 页面用到的服务。 */
export const inject = ["slots", "locale", "uiWorkspace", "sessions"];

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-conversation-manager: dictionaries");
  const t = ctx.locale.bind(NS);
  // ctx.sessions 的类型被别的 client 半的声明占住（SessionStore），按既有做法从服务面取。
  const sessions = ctx.get("sessions") as unknown as ISessions;
  const controller = new ConversationManagerController({
    archiveSession: (sessionId) => ctx.uiWorkspace.archiveSession(sessionId),
    unarchiveSession: (sessionId) => ctx.uiWorkspace.unarchiveSession(sessionId),
    refresh: () => sessions.refresh(),
  });

  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: PANEL_ID,
        locale: NS,
        inject: () => controller.face,
      },
      ConversationManagerPage,
    ),
  );

  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => t("panel"),
        locale: NS,
      },
      ConversationManagerIcon,
    ),
  );
}
