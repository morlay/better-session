/**
 * Session Editor browser half: the chat-node renderers that replace the
 * upstream `conversation.chat.node` registrations (priority shadow) so the
 * edit / retry entry points render directly in the message actions row.
 */

import type { ClientContext, SessionId } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { SessionEditorController } from "./controller.ts";
import { registerChatNodeRenderers } from "./chat-node/register.ts";

export const inject = ["slots", "conversation", "connection", "sessions"];

/** 注册 UI 贡献 + chat-node renderer，共享同一 per-session controller。 */
export function apply(ctx: ClientContext): void {
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

  // 替换整个 conversation.chat.node：priority -1 最低渲染，shadow 上游注册。
  registerChatNodeRenderers(ctx, controllerFor);
}
