import type { Context } from "@deepseek-ai/cordis";
import type {} from "@morlay/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { SessionEditorController } from "./controller.ts";
import { registerChatNodeRenderers } from "./chat-node/register.ts";
import { registerComposerStats } from "./composer-stats/register.ts";
import { styling } from "@morlay/dsh-client-ui-primitives/client";
import { globals as messageIconGlobals } from "./chat-node/MessageIconActions.styles.ts";

export const inject = ["slots", "conversation", "connection", "sessions", "uiWorkspace"];

export function apply(ctx: Context): void {
  styling.injectGlobals(messageIconGlobals);

  const controllers = new Map<SessionId, SessionEditorController>();
  const controllerFor = (sessionId: SessionId): SessionEditorController => {
    let controller = controllers.get(sessionId);
    if (controller === undefined) {
      controller = new SessionEditorController(ctx, sessionId);
      controllers.set(sessionId, controller);
    }
    return controller;
  };

  ctx.on("connection/reset", () => {
    for (const controller of controllers.values()) void controller.load();
  });

  registerChatNodeRenderers(ctx, controllerFor);

  ctx.slots.inject("conversation.composer.dock", () => registerComposerStats(ctx.slots));
}
