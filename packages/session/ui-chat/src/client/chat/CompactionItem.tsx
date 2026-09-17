// A compaction marker does not replace shadowed transcript rows. It is
// expandable only when the current window includes its cited summary.

import { memo, useMemo, useState } from "react";
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  MarkdownText,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import { markdownLabels } from "../markdown-labels.ts";
import type { CompactionSummaryNode } from "../contract/snapshot.ts";
import { styling } from "@morlay/dsh-client-ui-primitives/client";
import { styles } from "./MessageItem.styles.ts";

interface CompactionItemProps {
  node: CompactionSummaryNode;
  /** Optional command title for a manual compaction folded into this marker. */
  title?: string;
  /** Command settlement text used when structured compaction counts are unavailable. */
  fallbackSummary?: string | null;
  /** The owning view's locale seat. */
  t: ChatViewSlotProps["t"];
}

/**
 * Renders the model-history compaction marker.
 * @param props - the marker node off the snapshot cache.
 * @returns the marker row, with the summary disclosure when one is available.
 */
export const CompactionItem = memo(function CompactionItem({
  node,
  title,
  fallbackSummary,
  t,
}: CompactionItemProps) {
  const [expanded, setExpanded] = useState(false);
  const labels = useMemo(() => markdownLabels(t), [t]);
  const expandable = node.summary !== null;
  const open = expandable && expanded;
  const summary =
    node.shadowedItemCount !== null && node.shadowedTokenCount !== null
      ? t("message.compaction.completed", {
          items: node.shadowedItemCount,
          tokens: node.shadowedTokenCount,
        })
      : (fallbackSummary ??
        (expandable ? t("message.compaction.expand") : t("message.compaction.unavailable")));
  return (
    <div {...styling.props(styles.compactionRow)}>
      <button
        type="button"
        {...styling.props(styles.compactionButton)}
        data-compaction-button=""
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        <span {...styling.props(styles.compactionLeading)} aria-hidden>
          <span
            {...styling.props(styles.compactionContextIcon)}
            data-compaction-context-icon=""
            data-compaction-icon="context"
          >
            <IconApiOutline14 />
          </span>
          <span
            {...styling.props(styles.compactionDisclosureIcon)}
            data-compaction-disclosure-icon=""
            data-compaction-disclosure={open ? "expanded" : "collapsed"}
          >
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span {...styling.props(styles.compactionTitle)}>{title ?? t("message.compaction")}</span>
        <span {...styling.props(styles.compactionSep)} aria-hidden />
        <span {...styling.props(styles.compactionSummary)}>{summary}</span>
      </button>
      {open && node.summary !== null && (
        <div {...styling.props(styles.compactionBody)} data-compaction-body="">
          <MarkdownText text={node.summary} labels={labels} />
        </div>
      )}
    </div>
  );
});
