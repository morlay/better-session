import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-client-ui-conversation/client";
import "@deepseek-ai/dsh-client-ui-chat/client";
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
          // keyed slot 同 key 同 priority 会抛错；priority -1 让本项目
          // 渲染器以最低优先级渲染，shadow 上游默认（priority 0）注册。
          priority: -1,
          inject: injectFace,
        } as never,
        UserMessageNodeView as never,
      ),
    );
  }
}
