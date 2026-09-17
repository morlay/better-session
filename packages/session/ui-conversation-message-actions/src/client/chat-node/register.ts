import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import "@morlay/dsh-client-ui-conversation/client";
import "@morlay/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import { UserMessageNodeView } from "./MessageItem.tsx";
import type { SessionEditorController } from "../controller.ts";

const NS = "conversation";

export function registerChatNodeRenderers(
  ctx: Context,
  controllerFor: (sessionId: SessionId) => SessionEditorController,
): void {
  const injectFace = (sessionId: SessionId) => controllerFor(sessionId).face;

  for (const key of ["user", "steering"] as const) {
    ctx.slots.inject("conversation.chat.node", () =>
      ctx.slots.register(
        {
          name: "conversation.chat.node",
          key,
          locale: NS,

          priority: -1,
          inject: injectFace,
        } as never,
        UserMessageNodeView as never,
      ),
    );
  }
}
