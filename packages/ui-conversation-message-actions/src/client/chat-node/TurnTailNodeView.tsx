import { memo } from "react";
import type { InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import type { ChatNodeViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { MessageIconActions } from "./MessageIconActions.tsx";
import { assistantText } from "./turn-assistant.ts";
import css from "./TurnTailNodeView.module.css";
import type { SessionEditorFace } from "../controller.ts";

type TurnTailNodeViewProps = ChatNodeViewProps<"turn-tail"> & InjectFace<SessionEditorFace>;

/**
 * Turn-local actions over the Location index, independent of Assistant
 * placement.
 *
 * 注意：本 renderer 是 `conversation.chat.node` 的 shadow 注册（priority -1），
 * 而 `renderSlotChain` / `renderSlot` 只在注册声明了对应 children 时由 slot
 * 链传入——turnTail / assistant-actions 的 children 已被上游（ui-conversation）
 * 声明，shadow 注册再声明会抛「already declared」，因此这里不消费子 slot。
 *
 * 编辑 / 重试按钮只挂在 **user 消息**（UserMessageNodeView）上，助手尾部不
 * 提供（避免对未闭合/无 user 输入的轮次误触）。
 */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node,
  forkAt,
  t,
  useSession,
}: TurnTailNodeViewProps) {
  const data = node.data;
  const hasLaterChatNode = useSession(
    (snapshot) => snapshot.chat.locations.getTurn(data.turn).at(-1) !== node.key,
  );
  const turn =
    node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : undefined;
  if (turn === undefined) return null;
  const closing = data.closing;
  const tail = null;
  if (closing === null) return tail === null ? null : <div className={css.root}>{tail}</div>;
  const runMs =
    turn.start === undefined || turn.end === undefined
      ? undefined
      : Math.max(0, turn.end.time - turn.start.time);
  return (
    <div className={css.root} data-turn-tail={data.turn} data-time-hover-root>
      <MessageIconActions
        text={assistantText(closing.blocks)}
        time={closing.time}
        runMs={runMs}
        ttftMs={data.ttftMs}
        tokensPerSecond={data.tokensPerSecond}
        clock="end"
        onBranch={() => {
          forkAt(closing.finalNode.seq);
        }}
        branchUnavailable={data.branchUnavailable || hasLaterChatNode}
        className={css.actions}
        t={t}
      />
    </div>
  );
});
