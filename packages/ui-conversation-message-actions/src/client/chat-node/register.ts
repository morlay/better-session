/**
 * Register this package's chat-node renderers behind the keyed
 * `conversation.chat.node` seat (新版 keyed slot). 新版把 `user`/`steering`
 * 渲染器内置在 `dsh-client-ui-chat`；本项目仅**替换** `user`/`steering`，
 * 通过注册时的自定义 inject face 注入 `SessionEditorFace`，在消息动作行上
 * 提供 edit / retry（新版无此能力）。其余 key（context / assistant /
 * compaction / retry-chain / turn-error / turn-max-tokens / unknown 等）由
 * 新版内置渲染器继续处理，本项目不再重复注册。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-client-ui-conversation/client";
import "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import { UserMessageNodeView } from "./MessageItem.tsx";
import type { SessionEditorController } from "../controller.ts";

/** `conversation` 字典命名空间（与上游一致）。 */
const NS = "conversation";

/**
 * 注册本项目替换的 chat-node key（user / steering）。
 * 新版 keyed slot 复用同一 key 即替换该节点的内置渲染器。注册时的 inject
 * 返回项目 per-session 的 `SessionEditorFace`（含 edit / retry），组件经
 * `InjectFace<SessionEditorFace>` 接收。
 * @param ctx - client root context。
 * @param controllerFor - 解析 per-session editor controller。
 */
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
