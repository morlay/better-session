/**
 * Session Editor browser half: the chat-node renderers that replace the
 * upstream `conversation.chat.node` registrations (priority shadow) so the
 * edit / retry entry points render directly in the message actions row.
 */

import type { ClientContext, SessionId } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { SessionEditorController } from "./controller.ts";
import { registerChatNodeRenderers } from "./chat-node/register.ts";
import { CleanseSessionAction } from "./cleanse-session-action.tsx";

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

  // 会话头部「清洗会话」入口：仅历史加载失败（openState === "error"）时
  // 显示。header.actions 是 list 槽（注册需 id），上游未注册组件——这里是
  // 纯新增，无 shadow 冲突；priority -1 与其它注入面一致。
  ctx.slots.register(
    {
      name: "conversation.session.header.actions",
      id: "session-editor.cleanse",
      priority: -1,
      inject: (sessionId: SessionId) => controllerFor(sessionId).face,
    } as never,
    CleanseSessionAction as never,
  );
}
