// Shared IconActions chrome for user and assistant messages: copy
// live, optional branch wiring, and an optional date-aware clock.

import { styling } from "@morlay/dsh-client-ui-primitives/client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  IconBranchOutline16,
  IconCheckOutline16,
  IconCopyOutline16,
  IconEditOutline16,
  IconRefreshOutline16,
  Tooltip,
  writeClipboard,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import {
  formatLatencySeconds,
  formatMessageClock,
  formatRunDuration,
  formatTokensPerSecond,
} from "./message-chrome.ts";
import { useCalendarDay } from "./use-calendar-day.ts";
import { styles } from "./MessageIconActions.styles.ts";

export interface MessageIconActionsProps {
  text: string;

  time?: number | undefined;

  runMs?: number | undefined;

  ttftMs?: number | undefined;

  tokensPerSecond?: number | undefined;

  clock: "start" | "end";

  onBranch?: (() => void) | undefined;

  branchUnavailable?: boolean | undefined;

  className?: string | undefined;

  extraActions?: ReactNode;

  onEdit?: (() => void) | undefined;

  onRetry?: (() => void) | undefined;

  t: ChatViewSlotProps["t"];
}

export function MessageIconActions({
  text,
  time,
  runMs,
  ttftMs,
  tokensPerSecond,
  clock,
  onBranch,
  branchUnavailable = false,
  className,
  extraActions,
  onEdit,
  onRetry,
  t,
}: MessageIconActionsProps) {
  const day = useCalendarDay();
  const reasonId = useId();
  // Same success chrome as CodeBlock: a short check swap after the write,
  // gated so re-clicks during the window neither re-copy nor stack timers.
  const [copied, setCopied] = useState(false);
  const copyPending = useRef(false);
  const copyTimer = useRef<number | null>(null);
  const copyEpoch = useRef(0);
  useEffect(
    () => () => {
      copyEpoch.current += 1;
      copyPending.current = false;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );
  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return;
    const epoch = copyEpoch.current;
    copyPending.current = true;
    void writeClipboard(text).then((ok) => {
      if (epoch !== copyEpoch.current) return;
      copyPending.current = false;
      if (!ok) return;
      setCopied(true);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1000);
    });
  }, [copied, text]);
  // The dot is decorative and stays hidden, but its margins separate the
  // readings only on screen: without the flanking spaces a reader hears one
  // run-on string ("Ran for 13sTime to first token (TTFT) 0.2s12 tok/s")
  // instead of three facts.
  const clockEl =
    time === undefined ? null : (
      <span
        data-time-label=""
        {...styling.props(clock === "start" ? styles.timeStart : styles.timeEnd)}
      >
        {formatMessageClock(time, t, day)}
        {runMs !== undefined && (
          <>
            {" "}
            <span {...styling.props(styles.runTimeDot)} aria-hidden>
              ·
            </span>{" "}
            {t("message.ranFor", { duration: formatRunDuration(runMs, t) })}
          </>
        )}
        {ttftMs !== undefined && (
          <>
            {" "}
            <span {...styling.props(styles.runTimeDot)} aria-hidden>
              ·
            </span>{" "}
            {t("message.turnTime.ttft")}{" "}
            {t("duration.seconds", { seconds: formatLatencySeconds(ttftMs) })}
          </>
        )}
        {tokensPerSecond !== undefined && (
          <>
            {" "}
            <span {...styling.props(styles.runTimeDot)} aria-hidden>
              ·
            </span>{" "}
            {t("message.tokensPerSecond", { tps: formatTokensPerSecond(tokensPerSecond) })}
          </>
        )}
      </span>
    );
  // 外部 className 需要拼接：给 actions 一个真实类名（而不是 data-css 属性）。
  const actionsClass = styling.className(styles.actions);
  return (
    <div
      data-time-hover-root=""
      className={className === undefined ? actionsClass : `${actionsClass} ${className}`}
    >
      {clock === "start" ? clockEl : null}
      <Tooltip label={copied ? t("copied" as never) : t("copy" as never)} side="bottom">
        <button
          type="button"
          {...styling.props(styles.action)}
          aria-label={copied ? t("copied" as never) : t("copy" as never)}
          onClick={onCopy}
        >
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        </button>
      </Tooltip>
      {extraActions}
      {onEdit !== undefined && (
        <Tooltip label="编辑" side="bottom">
          <button
            type="button"
            {...styling.props(styles.action)}
            aria-label="编辑"
            onClick={onEdit}
          >
            <IconEditOutline16 />
          </button>
        </Tooltip>
      )}
      {onRetry !== undefined && (
        <Tooltip label="重试此回合" side="bottom">
          <button
            type="button"
            {...styling.props(styles.action)}
            aria-label="重试此回合"
            onClick={onRetry}
          >
            <IconRefreshOutline16 />
          </button>
        </Tooltip>
      )}
      {onBranch !== undefined && (
        <Tooltip
          label={branchUnavailable ? t("message.branchUnavailable") : t("message.branch")}
          side="bottom"
        >
          {/* Native disabled buttons do not deliver the hover/focus events Tooltip needs. */}
          <button
            type="button"
            {...styling.props(styles.action)}
            aria-label={t("message.branch")}
            aria-disabled={branchUnavailable || undefined}
            aria-describedby={branchUnavailable ? reasonId : undefined}
            data-unavailable={branchUnavailable || undefined}
            onClick={branchUnavailable ? undefined : onBranch}
          >
            <IconBranchOutline16 />
          </button>
        </Tooltip>
      )}
      {onBranch !== undefined && branchUnavailable && (
        <span id={reasonId} {...styling.props(styles.visuallyHidden)}>
          {t("message.branchUnavailable")}
        </span>
      )}
      {clock === "end" ? clockEl : null}
    </div>
  );
}
