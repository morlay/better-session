/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useState } from "react";
import { DisclosureRow, IconThinkOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import { styles as a11yStyles } from "./accessibility.styles.ts";
import { styling } from "@morlay/dsh-client-ui-primitives/client";
import { styles } from "./ReasoningRow.styles.ts";

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf("\n");
  return newline === -1 ? visible : visible.slice(newline + 1);
}

/**
 * Render one assistant reasoning block collapsed until the reader opens it. The
 * collapsed summary omits double-asterisk markers; expanded content preserves
 * the complete text.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({
  text,
  running,
  t,
}: {
  text: string;
  running: boolean;
  t: ChatViewSlotProps["t"];
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = (running ? latestLine(text) : firstLine(text)).replaceAll("**", "");

  return (
    <div
      {...styling.props(styles.root)}
      data-variant="think"
      data-state={running ? "running" : "ok"}
      data-expanded={expanded || undefined}
    >
      {running && <span {...styling.props(a11yStyles.visuallyHidden)}>{t("row.running")}</span>}
      <DisclosureRow
        rowClassName={styling.className(styles.row)}
        leadingClassName={styling.className(styles.leading)}
        titleClassName={styling.className(styles.title)}
        chevronClassName={styling.className(styles.chevron)}
        icon={<IconThinkOutline14 size={14} />}
        title={t("message.think")}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => {
          setExpanded((value) => !value);
        }}
        collapsedContent={
          <>
            <span {...styling.props(styles.separator)} aria-hidden />
            <span {...styling.props(styles.summary)} data-follow-end={running || undefined}>
              <span {...styling.props(styles.summaryText)} data-reasoning-summary="">
                {summary}
              </span>
            </span>
          </>
        }
      >
        <div {...styling.props(styles.thinkBody)}>{text}</div>
      </DisclosureRow>
    </div>
  );
}
