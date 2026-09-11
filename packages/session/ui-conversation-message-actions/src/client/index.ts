import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { SessionEditorController } from "./controller.ts";
import { registerChatNodeRenderers } from "./chat-node/register.ts";
import { SessionImportAction } from "./import-action.tsx";

export const inject = ["slots", "conversation", "connection", "sessions"];

export function apply(ctx: Context): void {
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

  // 新版 `conversation.chat.node` 是 keyed slot（reuse key 即替换该节点的
  // 渲染器）；register 内部经 ctx.slots.inject 等待声明。
  registerChatNodeRenderers(ctx, controllerFor);

  // 会话头部「导入会话」入口：导出按钮旁（header.utilities list 槽），
  // 用导出的 zip 覆盖当前会话内容（host 端 `/api/session.import`）。
  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "session-editor.import",
        inject: (sessionId: SessionId) => {
          const face = controllerFor(sessionId).face;
          return {
            hooks: face.hooks,
            // face 方法是闭包（已绑定 this），直接透传。
            importSession: (file: File) => face.importSession(file),
          };
        },
      } as never,
      SessionImportAction as never,
    ),
  );
}
