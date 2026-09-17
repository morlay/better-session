import { memo } from "react";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatNodeViewProps } from "../contract/slots.ts";
import { styling } from "@morlay/dsh-client-ui-primitives/client";
import { styles } from "./TurnProcessNodeView.styles.ts";

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node,
  turnProcess,
  t,
}: ChatNodeViewProps<"turn-process">) {
  if (turnProcess === undefined)
    throw new Error("turn-process node requires Turn process owner state");
  if (!turnProcess.foldable) return null;
  const open = turnProcess.open;
  const labels: string[] = [];
  if (node.data.toolCallCount > 0) {
    labels.push(
      t(
        node.data.toolCallCount === 1
          ? "message.turnProcess.toolCalls.one"
          : "message.turnProcess.toolCalls.other",
        { count: node.data.toolCallCount },
      ),
    );
  }
  if (node.data.messageCount > 0) {
    labels.push(
      t(
        node.data.messageCount === 1
          ? "message.turnProcess.messages.one"
          : "message.turnProcess.messages.other",
        { count: node.data.messageCount },
      ),
    );
  }
  if (node.data.subagentCount > 0) {
    labels.push(
      t(
        node.data.subagentCount === 1
          ? "message.turnProcess.subagents.one"
          : "message.turnProcess.subagents.other",
        { count: node.data.subagentCount },
      ),
    );
  }
  const label =
    labels.length === 0
      ? t("message.turnProcess.thoughtForAWhile")
      : labels.join(t("message.turnProcess.separator"));
  return (
    <button
      type="button"
      {...styling.props(styles.root)}
      data-open={open || undefined}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus();
        turnProcess.setOpen(!open);
      }}
    >
      <span {...styling.props(styles.label)}>{label}</span>
      <IconChevronDownOutline14
        className={`${styling.className(styles.chevron)} dsh-node-chevron`}
      />
    </button>
  );
});
