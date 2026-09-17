import { memo, useMemo } from "react";
import type { PropsRenderSlots } from "@deepseek-ai/dsh-client-ui-slots";
import type { ChatNodeViewProps, CommandRowOwnerProps } from "../contract/slots.ts";
import { CompactionCommandCard } from "./CompactionCommandCard.tsx";
import { GenericCommandCard } from "./GenericCommandCard.tsx";
import { styling } from "@morlay/dsh-client-ui-primitives/client";
import { styles } from "./ChatView.styles.ts";

type CommandNodeViewProps = ChatNodeViewProps<"command"> &
  PropsRenderSlots<"conversation.chat.commandview">;

/** Ordinary command lifecycle renderer with command-name keyed specialization. */
export const CommandNodeView = memo(function CommandNodeView({
  node,
  renderSlot,
  t,
}: CommandNodeViewProps) {
  const command = node.data;
  const owner = useMemo<CommandRowOwnerProps>(() => ({ node: command }), [command]);
  return (
    <div {...styling.props(styles.callRow)}>
      {renderSlot("conversation.chat.commandview", owner, {
        entryKey: command.name ?? "",
        fallback: <GenericCommandCard {...owner} t={t} />,
      })}
    </div>
  );
});

/** One integrated `/compact` command and compaction transaction renderer. */
export const ManualCompactionNodeView = memo(function ManualCompactionNodeView({
  node,
  t,
}: ChatNodeViewProps<"manual-compaction">) {
  const data = node.data;
  return (
    <div {...styling.props(styles.callRow)}>
      <CompactionCommandCard
        node={data.command}
        {...(data.compaction === null ? {} : { compaction: data.compaction })}
        t={t}
      />
    </div>
  );
});
