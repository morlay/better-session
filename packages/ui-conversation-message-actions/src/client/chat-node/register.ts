/**
 * Register this package's chat-node renderers behind the keyed
 * `conversation.chat.node` seat. Every key is re-registered at `priority: -1`
 * so the lowest priority wins and the upstream renderers are shadowed without
 * touching `@deepseek-ai/*`. The per-session editor face is injected so the
 * copied renderers can drive edit / retry directly.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-client-runtime/client";
import "@deepseek-ai/dsh-client-ui-conversation/client";
import { AssistantNodeView } from "./AssistantNodeView.tsx";
import { CommandNodeView, ManualCompactionNodeView } from "./CommandNodeView.tsx";
import {
  CompactionNodeView,
  ContextMessageNodeView,
  RetryNodeView,
  TurnErrorNodeView,
  TurnMaxTokensNodeView,
  UnknownNodeView,
  UserMessageNodeView,
} from "./MessageItem.tsx";
import { TurnTailNodeView } from "./TurnTailNodeView.tsx";
import type { SessionEditorController } from "../controller.ts";

/** `conversation` 字典命名空间（与上游一致）。 */
const NS = "conversation";

/** 注册全部 chat-node key；priority -1 替换上游渲染。 */
export function registerChatNodeRenderers(
  ctx: Context,
  controllerFor: (sessionId: SessionId) => SessionEditorController,
): void {
  const inject = (sessionId: SessionId) => controllerFor(sessionId).face;

  ctx.slots.register(
    { name: "conversation.chat.node", key: "user", locale: NS, priority: -1, inject },
    UserMessageNodeView,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "steering", locale: NS, priority: -1, inject },
    UserMessageNodeView,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "context", locale: NS, priority: -1, inject },
    ContextMessageNodeView,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "assistant-step", locale: NS, priority: -1, inject },
    AssistantNodeView,
  );
  ctx.slots.register(
    // command / turn-tail 的 children 由上游声明（commandview / turnTail /
    // assistant-actions）；shadow 注册不重复声明，仅替换渲染器。
    { name: "conversation.chat.node", key: "command", locale: NS, priority: -1, inject } as never,
    CommandNodeView as never,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "manual-compaction", locale: NS, priority: -1, inject },
    ManualCompactionNodeView,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "compaction", locale: NS, priority: -1, inject },
    CompactionNodeView,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "model-retry", locale: NS, priority: -1, inject },
    RetryNodeView,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "turn-error", locale: NS, priority: -1, inject },
    TurnErrorNodeView,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "turn-max-tokens", locale: NS, priority: -1, inject },
    TurnMaxTokensNodeView,
  );
  ctx.slots.register(
    // 见 command：turnTail / assistant-actions 的 children 由上游声明。
    { name: "conversation.chat.node", key: "turn-tail", locale: NS, priority: -1, inject } as never,
    TurnTailNodeView as never,
  );
  ctx.slots.register(
    { name: "conversation.chat.node", key: "unknown", locale: NS, priority: -1, inject },
    UnknownNodeView,
  );
}
