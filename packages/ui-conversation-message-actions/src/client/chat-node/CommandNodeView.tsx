import { memo, useMemo } from "react";
import type {
  ChatNodeViewProps,
  CommandRowOwnerProps,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { CompactionCommandCard } from "./CompactionCommandCard.tsx";
import { GenericCommandCard } from "./GenericCommandCard.tsx";
import css from "./ChatView.module.css";

type CommandNodeViewProps = ChatNodeViewProps<"command">;

/**
 * Ordinary command lifecycle renderer. 注意：shadow 注册（priority -1）无法
 * 声明 `conversation.chat.commandview` children（已被上游声明，重复声明会抛
 * 「already declared」），因此这里不消费 `renderSlot` 子 slot，直接渲染通用
 * command 卡片。
 */
export const CommandNodeView = memo(function CommandNodeView({ node, t }: CommandNodeViewProps) {
  const command = node.data;
  const owner = useMemo<CommandRowOwnerProps>(() => ({ node: command }), [command]);
  return (
    <div className={css.callRow}>
      <GenericCommandCard {...owner} t={t} />
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
    <div className={css.callRow}>
      <CompactionCommandCard
        node={data.command}
        {...(data.compaction === null ? {} : { compaction: data.compaction })}
        t={t}
      />
    </div>
  );
});
